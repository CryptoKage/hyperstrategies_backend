// server/routes/user.js
// FINAL VERSION: The /profile route is updated to use the new 'pins' table.

const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');
const axios = require('axios');
const erc20Abi = require('../utils/abis/erc20.json');
const { ok, fail } = require('../utils/response');
const { calculateActiveEffects } = require('../utils/effectsEngine');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);
const apeContract = new ethers.Contract(tokenMap.ape.address, erc20Abi, provider);
const crypto = require('crypto');

const priceCache = {
  apePrice: null,
  lastFetched: 0,
  cacheDuration: 5 * 60 * 1000,
};

async function getApePrice() {
  const now = Date.now();
  if (priceCache.apePrice && (now - priceCache.lastFetched < priceCache.cacheDuration)) {
    return priceCache.apePrice;
  }
  
  try {
    console.log('Fetching fresh APE price from CoinGecko...');
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=apecoin&vs_currencies=usd',
      { timeout: 5000 }
    );
    const price = response.data.apecoin.usd;
    priceCache.apePrice = price;
    priceCache.lastFetched = now;
    return price;
  } catch (error) {
     if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      console.error('CoinGecko API call timed out:', error.message);
    } else {
      console.error('CoinGecko API call failed:', error.message);
    }
    if (priceCache.apePrice) {
      console.warn('Serving STALE APE price from cache due to API failure.');
      return priceCache.apePrice;
    }
    console.error('CRITICAL: Could not fetch APE price and no cache is available.');
    return 0;
  }
}

router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // --- FIX #1: Add the new 'pendingCheckResult' variable to the list ---
    const [userResult, portfolioSumsResult, bonusPointsResult, pendingCheckResult] = await Promise.all([
      pool.query('SELECT balance, eth_address FROM users WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT 
           COALESCE(SUM(amount), 0) as total_capital,
           COALESCE(SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END), 0) as total_pnl
         FROM vault_ledger_entries WHERE user_id = $1`, [userId]),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      // This is your new query, which is already correctly placed.
      pool.query(
        `SELECT EXISTS (
            SELECT 1 FROM user_activity_log 
            WHERE 
              user_id = $1 
              AND activity_type = 'VAULT_WITHDRAWAL_REQUEST' 
              AND status IS NOT NULL 
              AND status NOT IN ('COMPLETED', 'FAILED')
        ) as has_pending`,
        [userId]
      )
    ]);
    if (userResult.rows.length === 0) { return res.status(404).json({ error: 'User not found.' }); }
    const userData = userResult.rows[0];
    const portfolioData = portfolioSumsResult.rows[0];
    const bonusPointsData = bonusPointsResult.rows[0];
    
    // --- FIX #2: Add the new 'pendingVaultWithdrawal' flag to the response ---
    res.json({
      address: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalCapitalInVaults: parseFloat(portfolioData.total_capital),
      totalUnrealizedPnl: parseFloat(portfolioData.total_pnl),
      totalBonusPoints: parseFloat(bonusPointsData.total_bonus_points),
      pendingVaultWithdrawal: pendingCheckResult.rows[0].has_pending
    });
  } catch (err) {
    console.error('Error in /wallet endpoint:', err);
    res.status(500).send('Server Error');
  }
});

router.get('/profile', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    // 1. Fetch all necessary data in parallel
    const [profileResult, ownedPinsResult, activePinIdsResult, userEffects, totalStakedResult] = await Promise.all([
      client.query(`
        SELECT u.username, u.email, u.xp, u.referral_code, u.account_tier, u.auto_equip_pins
        FROM users u 
        WHERE u.user_id = $1;
      `, [userId]),
      // Get ALL pins the user owns, with details
      client.query(`
        SELECT p.pin_id, pd.pin_name, pd.pin_description, pd.image_filename
        FROM pins p
        JOIN pin_definitions pd ON p.pin_name = pd.pin_name
        WHERE p.owner_id = $1 
        ORDER BY p.pin_id;
      `, [userId]),
      // Get a simple list of which pin IDs are active
      client.query('SELECT pin_id FROM user_active_pins WHERE user_id = $1', [userId]),
      // Use our engine to calculate total available slots
      calculateActiveEffects(userId, client),
      client.query(
        `SELECT COALESCE(SUM(amount), 0) as total_capital 
         FROM vault_ledger_entries 
         WHERE user_id = $1 AND entry_type IN ('DEPOSIT', 'VAULT_TRANSFER_IN', 'PNL_DISTRIBUTION', 'PERFORMANCE_FEE', 'BONUS_POINT_BUYBACK_CREDIT')`, // Use a comprehensive list of credit-like types
        [userId]
      )
    ]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // 2. Assemble the final, rich data payload for the frontend
    const profileData = profileResult.rows[0];
    const ownedPins = ownedPinsResult.rows;
    const activePinIds = activePinIdsResult.rows.map(r => r.pin_id);
    const totalPinSlots = userEffects.total_pin_slots;

    res.json({
      ...profileData,
      ownedPins: ownedPins,         // Array of objects with full pin details
      activePinIds: activePinIds,   // Array of integers, e.g., [101, 102]
      totalPinSlots: totalPinSlots,  // A single number, e.g., 3
      auto_equip_pins: profileData.auto_equip_pins,
      total_staked_capital: parseFloat(totalStakedResult.rows[0].total_capital)
    });
  } catch (err) {
    console.error('Error fetching rich profile data:', err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

router.put('/profile', authenticateToken, async (req, res) => {
  const { username: newUsername } = req.body;
  const currentUserId = req.user.id;

  if (!newUsername || typeof newUsername !== 'string' || newUsername.trim().length < 3) {
    return res.status(400).json(fail('USERNAME_TOO_SHORT'));
  }
  const sanitizedUsername = newUsername.trim();
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
  
    const currentUserResult = await client.query('SELECT username FROM users WHERE user_id = $1', [currentUserId]);
    if (currentUserResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json(fail('USER_NOT_FOUND'));
    }
    const oldUsername = currentUserResult.rows[0].username;

    const existingUserCheck = await client.query(
      'SELECT user_id FROM users WHERE username = $1 AND user_id != $2',
      [sanitizedUsername, currentUserId]
    );

    if (existingUserCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json(fail('USERNAME_TAKEN', { username: sanitizedUsername }));
    }
  
    await client.query('UPDATE users SET username = $1 WHERE user_id = $2', [sanitizedUsername, currentUserId]);
    await client.query(`INSERT INTO username_history (user_id, old_username, new_username) VALUES ($1, $2, $3)`, [currentUserId, oldUsername, sanitizedUsername]);
   
    await client.query('COMMIT');
    res.status(200).json(ok('PROFILE_SAVED'));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error updating username for user ${currentUserId}:`, err);
    res.status(500).json(fail('GENERIC_SERVER_ERROR'));
  } finally {
    client.release();
  }
});

router.get('/activity-log', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const activityQuery = `
      SELECT activity_id, activity_type, description, amount_primary, symbol_primary, status, created_at
      FROM user_activity_log
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3;
    `;
    const { rows } = await pool.query(activityQuery, [userId, limit, offset]);
    res.json(rows);
  } catch (err) {
    console.error(`Error fetching activity log for user ${req.user.id}:`, err);
    res.status(500).send('Server Error');
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboardResult = await pool.query(
      `SELECT username, referral_code, xp 
       FROM users 
       WHERE referral_code IS NOT NULL 
       ORDER BY xp DESC, created_at ASC 
       LIMIT 25`
    );
    res.json(leaderboardResult.rows);
  } catch (err) {
    console.error('Error fetching leaderboard:', err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/my-rank', authenticateToken, async (req, res) => {
  try {
    const authenticatedUserId = req.user.id;
    const fetchUserRankAndXpQuery = `
      SELECT user_rank, user_xp FROM (
        SELECT 
          user_id, 
          xp as user_xp,
          RANK() OVER (ORDER BY xp DESC, created_at ASC) as user_rank
        FROM 
          users
      ) as ranked_users
      WHERE user_id = $1;
    `;
    const { rows } = await pool.query(fetchUserRankAndXpQuery, [authenticatedUserId]);
    if (rows.length === 0) {
      return res.status(404).json({ msg: 'User rank could not be determined.' });
    }
    const currentUserRank = rows[0].user_rank;
    const currentUserXp = rows[0].user_xp;
    res.json({ 
      rank: currentUserRank,
      xp: currentUserXp 
    });
  } catch (err) {
    console.error("Error fetching user rank:", err.message);
    res.status(500).send('Server Error');
  }
});

router.put('/referral-code', authenticateToken, async (req, res) => {
  const { desiredCode } = req.body;
  const authenticatedUserId = req.user.id;
  if (!desiredCode || typeof desiredCode !== 'string') {
    return res.status(400).json(fail('REFERRAL_CODE_REQUIRED'));
  }
  const sanitizedCode = desiredCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (sanitizedCode.length < 3 || sanitizedCode.length > 15) {
    return res.status(400).json(fail('INVALID_REFERRAL_CODE'));
  }
  const finalReferralCode = `HS-${sanitizedCode}`;
  try {
    const existingCodeResult = await pool.query(
      'SELECT user_id FROM users WHERE referral_code = $1',
      [finalReferralCode]
    );
    if (existingCodeResult.rows.length > 0) {
      if (existingCodeResult.rows[0].user_id !== authenticatedUserId) {
        return res.status(409).json(fail('REFERRAL_CODE_TAKEN', { code: finalReferralCode }));
      }
      // If it's already their code, we can just send a success response.
      return res.status(200).json(ok('REFERRAL_CODE_UNCHANGED', { code: finalReferralCode }));
    }
    
    await pool.query(
      'UPDATE users SET referral_code = $1 WHERE user_id = $2',
      [finalReferralCode, authenticatedUserId]
    );
    
    // We pass the code back so the frontend can display it if needed.
    res.status(200).json(ok('REFERRAL_CODE_SAVED', { code: finalReferralCode }));

  } catch (err) {
    if (err.code === '23505') { // Handles a race condition where the code was just taken
      return res.status(409).json(fail('REFERRAL_CODE_TAKEN', { code: finalReferralCode }));
    }
    console.error("Error updating referral code:", err.message);
    res.status(500).json(fail('GENERIC_SERVER_ERROR'));
  }
});

router.get('/xp-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const historyQuery = `
      SELECT
        activity_id,
        description,
        amount_primary,
        created_at
      FROM
        user_activity_log
      WHERE
        user_id = $1 AND
        ( 
          activity_type LIKE 'XP_%' AND
          activity_type != 'XP_STAKING_BONUS'
        ) OR 
        (activity_type = 'BONUS_POINT_BUYBACK' AND symbol_primary = 'USDC')
      ORDER BY
        created_at DESC
      LIMIT $2 OFFSET $3;
    `;
    const { rows } = await pool.query(historyQuery, [userId, limit, offset]);
    res.json(rows);
  } catch (err) {
    console.error(`Error fetching XP history for user ${req.user.id}:`, err);
    res.status(500).send('Server Error');
  }
});

router.put('/vault-settings/:vaultId/compound', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  const { autoCompound } = req.body;
  const userId = req.user.id;
  if (typeof autoCompound !== 'boolean') {
    return res.status(400).json({ message: 'Invalid autoCompound value.' });
  }
  try {
    const upsertQuery = `
      INSERT INTO user_vault_settings (user_id, vault_id, auto_compound) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, vault_id) DO UPDATE SET auto_compound = $3;
    `;
    await pool.query(upsertQuery, [userId, vaultId, autoCompound]);
    res.status(200).json({ 
      message: `Auto-compounding for vault ${vaultId} has been turned ${autoCompound ? 'ON' : 'OFF'}.`
    });
  } catch (err) {
    console.error('Error updating auto-compound setting:', err);
    res.status(500).send('Server Error');
  }
});

// --- NEW EASTER EGG ENDPOINT: Mint Troll Pin (Corrected) ---
router.post('/mint-troll-pin', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const pinToMint = 'TROLL';

  let client;
  try {
    client = await pool.connect();

    // --- THE FIX: First, check if the user already owns this specific type of pin ---
    const existingPinCheck = await client.query(
      `SELECT pin_id FROM pins WHERE owner_id = $1 AND pin_name = $2`,
      [userId, pinToMint]
    );

    if (existingPinCheck.rows.length > 0) {
      // The user already has the pin.
      console.log(`User ${userId} attempted to mint the ${pinToMint} pin again.`);
      return res.status(200).json({ message: `You already have this pin!` });
    }

    // If the check passes, mint the new pin.
    const result = await client.query(
      `INSERT INTO pins (owner_id, pin_name) VALUES ($1, $2) RETURNING *`,
      [userId, pinToMint]
    );

    // This was the first time the user got the pin.
    console.log(`User ${userId} has successfully minted the ${pinToMint} pin.`);
    res.status(201).json({ message: `u trollin? 트롤`, newPin: result.rows[0] });

  } catch (err) {
    console.error(`Error minting TROLL pin for user ${userId}:`, err);
    res.status(500).json({ message: 'Could not mint the pin at this time.' });
  } finally {
    if (client) client.release();
  }
});


router.post('/active-pins', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // Expecting an array of unique pin IDs from the frontend, e.g., [101, 102, 103]
  const { activePinIds } = req.body;

  // Basic validation
  if (!Array.isArray(activePinIds)) {
    return res.status(400).json({ error: 'activePinIds must be an array.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Determine the user's total available slots.
    // We call the engine first, as a pin MIGHT grant bonus slots.
    const userEffects = await calculateActiveEffects(userId, client);
    const availableSlots = userEffects.total_pin_slots;

    if (activePinIds.length > availableSlots) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `You can only equip up to ${availableSlots} pins.` });
    }

    // 2. Verify that the user actually owns all the pins they are trying to equip.
    // This is a critical security check.
    const ownedPinsResult = await client.query(
      'SELECT pin_id FROM pins WHERE owner_id = $1 AND pin_id = ANY($2::int[])',
      [userId, activePinIds]
    );

    if (ownedPinsResult.rows.length !== activePinIds.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are trying to equip a pin you do not own.' });
    }
    
    // 3. If all checks pass, update their active loadout.
    // We first delete all of their old active pins.
    await client.query('DELETE FROM user_active_pins WHERE user_id = $1', [userId]);

    // Then, we insert the new loadout.
    if (activePinIds.length > 0) {
      const insertValues = activePinIds.map((pinId, index) => `('${userId}', ${pinId}, ${index + 1})`).join(',');
      const insertQuery = `INSERT INTO user_active_pins (user_id, pin_id, slot_number) VALUES ${insertValues}`;
      await client.query(insertQuery);
    }
    
    await client.query('COMMIT');
    res.status(200).json({ message: 'Pin loadout updated successfully.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error updating active pins for user ${userId}:`, error);
    res.status(500).json({ error: 'An error occurred while updating your pin loadout.' });
  } finally {
    client.release();
  }
});

router.put('/pins/auto-equip', authenticateToken, async (req, res) => {
  const { isEnabled } = req.body;
  const userId = req.user.id;

  if (typeof isEnabled !== 'boolean') {
    return res.status(400).json({ error: 'isEnabled must be a boolean.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      'UPDATE users SET auto_equip_pins = $1 WHERE user_id = $2',
      [isEnabled, userId]
    );

    // If the user is turning auto-equip ON, we should immediately run it for them.
    if (isEnabled) {
      const { autoEquipBestPins } = require('../utils/pinUtils');
      await autoEquipBestPins(userId, client);
    }
    
    await client.query('COMMIT');
    res.status(200).json({ message: 'Setting updated successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error updating auto-equip for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to update setting.' });
  } finally {
    client.release();
  }
});

router.get('/rewards', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [unclaimedResult, historyResult, totalResult] = await Promise.all([
      // Query 1: Get the SUM of all 'UNCLAIMED' XP (no change here)
      pool.query(
        `SELECT COALESCE(SUM(amount_primary), 0) as total 
         FROM user_activity_log 
         WHERE user_id = $1 AND status = 'UNCLAIMED' AND activity_type = 'XP_BOUNTY'`,
        [userId]
      ),
      // --- THIS IS THE NEW QUERY ---
      // Query 2: Get a direct list of all 'CLAIMED' XP transactions.
      pool.query(
        `SELECT activity_id, description, amount_primary, created_at
         FROM user_activity_log 
         WHERE user_id = $1 AND status = 'CLAIMED' AND activity_type LIKE 'XP_%'
         ORDER BY created_at DESC
         LIMIT 50`, // Add pagination later if needed
        [userId]
      ),
      // Query 3: Get the user's total current XP from the users table.
      pool.query('SELECT xp FROM users WHERE user_id = $1', [userId])
    ]);
    
    const unclaimedXp = parseFloat(unclaimedResult.rows[0].total);
    const totalXp = parseFloat(totalResult.rows.length > 0 ? totalResult.rows[0].xp : 0);

    res.json({
      unclaimedXp: unclaimedXp,
      totalXp: totalXp,
      claimedHistory: historyResult.rows // We now return the raw rows
    });

  } catch (error) {
    console.error(`Error fetching rewards for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to fetch rewards data.' });
  }
});

// --- POST Endpoint: Claim all available XP ---
router.post('/rewards/claim', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- THIS IS THE FIX ---
    // 1. Select the individual UNCLAIMED rows for this user and lock them.
    const unclaimedRowsResult = await client.query(
      `SELECT activity_id, amount_primary 
       FROM user_activity_log 
       WHERE user_id = $1 AND status = 'UNCLAIMED' AND activity_type = 'XP_BOUNTY' 
       FOR UPDATE`,
      [userId]
    );

    const unclaimedActivities = unclaimedRowsResult.rows;

    if (unclaimedActivities.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'No XP to claim.', claimedAmount: 0 });
    }

    // 2. Calculate the total sum in JavaScript.
    const xpToClaim = unclaimedActivities.reduce((sum, activity) => sum + parseFloat(activity.amount_primary), 0);
    const activityIdsToUpdate = unclaimedActivities.map(a => a.activity_id);

    // 3. Mark all of the user's unclaimed XP entries as 'CLAIMED' using their IDs.
    await client.query(
      `UPDATE user_activity_log SET status = 'CLAIMED' 
       WHERE activity_id = ANY($1::uuid[])`,
      [activityIdsToUpdate]
    );

    // 4. Add the claimed XP to the user's main XP balance and update their tier.
    const userXpResult = await client.query(
      'UPDATE users SET xp = xp + $1 WHERE user_id = $2 RETURNING xp',
      [xpToClaim, userId]
    );
    
    const { calculateUserTier } = require('../utils/tierUtils');
    const newTotalXp = parseFloat(userXpResult.rows[0].xp);
    const newTier = calculateUserTier(newTotalXp);
    
    await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newTier, userId]);

    await client.query('COMMIT');
    res.status(200).json({ 
      message: `Successfully claimed ${xpToClaim.toFixed(2)} XP!`,
      claimedAmount: xpToClaim,
      newTotalXp: newTotalXp
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error claiming XP for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to claim XP.' });
  } finally {
    client.release();
  }
});

router.post('/link-wallet', authenticateToken, async (req, res) => {
  const { address, signature, message } = req.body;
  const userId = req.user.id;

  // 1. Basic Validation
  if (!address || !signature || !message) {
    return res.status(400).json({ error: 'Address, signature, and message are required.' });
  }

  try {
    // 2. Cryptographic Verification
    // Ethers.js will recover the address that signed the message.
    const recoveredAddress = ethers.utils.verifyMessage(message, signature);

    // We compare the recovered address to the address the user claimed to have.
    // This is case-insensitive for safety.
    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'Signature verification failed. The address does not match the signature.' });
    }
    
    // 3. Check if this wallet is already linked to another user.
    // This is a critical security check to prevent takeovers.
    const existingLink = await pool.query(
      'SELECT user_id FROM users WHERE external_evm_wallet = $1 AND user_id != $2',
      [recoveredAddress, userId]
    );

    if (existingLink.rows.length > 0) {
      return res.status(409).json({ error: 'This wallet address is already linked to another account.' });
    }

    // 4. If all checks pass, save the address to the user's profile.
    await pool.query(
      'UPDATE users SET external_evm_wallet = $1 WHERE user_id = $2',
      [recoveredAddress, userId]
    );

    res.status(200).json({ message: 'Wallet linked successfully!' });

  } catch (error) {
    // This will catch malformed signatures or other unexpected errors.
    console.error(`Error linking wallet for user ${userId}:`, error);
    res.status(500).json({ error: 'An error occurred during wallet verification.' });
  }
});

router.post('/session-store', (req, res) => {
  const { key, value } = req.body;
  if (key && value) {
    req.session[key] = value;
  }
  res.sendStatus(200);
});

router.post('/link-telegram', authenticateToken, async (req, res) => {
  // Telegram sends a user object in the request body
  const telegramUser = req.body;
  const userId = req.user.id;

  // 1. Basic Validation
  if (!telegramUser || !telegramUser.id || !telegramUser.hash) {
    return res.status(400).json({ error: 'Invalid Telegram data received.' });
  }

  try {
    // 2. Cryptographic Verification (CRITICAL SECURITY STEP)
    const secretKey = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest();
    
    // Collect all data fields from Telegram, sorted alphabetically
    const dataCheckString = Object.keys(telegramUser)
      .filter(key => key !== 'hash')
      .map(key => `${key}=${telegramUser[key]}`)
      .sort()
      .join('\n');

    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Compare our calculated hash with the hash Telegram sent. If they don't match, the data is fake.
    if (hmac !== telegramUser.hash) {
      return res.status(401).json({ error: 'Telegram data verification failed. Invalid hash.' });
    }

    const telegramId = telegramUser.id.toString();

    // 3. Check if this Telegram account is already linked to another user.
    const existingLink = await pool.query(
      'SELECT user_id FROM users WHERE telegram_id = $1 AND user_id != $2',
      [telegramId, userId]
    );
    if (existingLink.rows.length > 0) {
      return res.status(409).json({ error: 'This Telegram account is already linked to another user.' });
    }

    // 4. If all checks pass, save the Telegram ID to the user's profile.
    await pool.query(
      'UPDATE users SET telegram_id = $1 WHERE user_id = $2',
      [telegramId, userId]
    );
    
    res.status(200).json({ message: 'Telegram account linked successfully!' });

  } catch (error) {
    console.error(`Error linking Telegram for user ${userId}:`, error);
    res.status(500).json({ error: 'An error occurred during Telegram verification.' });
  }
});

router.get('/presale-eligibility', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const PRESALE_XP_REQUIREMENT = 1000; // The minimum XP needed to participate

  try {
    const result = await pool.query('SELECT xp FROM users WHERE user_id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userXp = parseFloat(result.rows[0].xp);
    const isEligible = userXp >= PRESALE_XP_REQUIREMENT;
    
    res.json({
      isEligible: isEligible,
      currentXp: userXp,
      xpRequired: PRESALE_XP_REQUIREMENT
    });

  } catch (error) {
    console.error(`Error fetching presale eligibility for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to fetch eligibility status.' });
  }
});

// Add these new routes inside routes/user.js

// --- Endpoint to get a list of a user's PUBLISHED reports ---
router.get('/reports/available', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const { rows } = await pool.query(
            `SELECT report_id, title, report_date 
             FROM user_monthly_reports 
             WHERE user_id = $1 AND status = 'APPROVED'
             ORDER BY report_date DESC`,
            [userId]
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error(`Error fetching available reports for user ${userId}:`, error);
        res.status(500).json({ error: 'Failed to fetch available reports.' });
    }
});

// --- Endpoint to get the data for a SINGLE report ---
router.get('/reports/:reportId', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { reportId } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT report_id, title, report_date, report_data 
             FROM user_monthly_reports 
             WHERE report_id = $1 AND user_id = $2 AND status = 'APPROVED'`,
            [reportId, userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Report not found or you do not have permission to view it.' });
        }

        res.status(200).json(rows[0]);
    } catch (error) {
        console.error(`Error fetching report ${reportId} for user ${userId}:`, error);
        res.status(500).json({ error: 'Failed to fetch report data.' });
    }
});


router.get('/report-eligibility', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const firstDepositResult = await pool.query(
            `SELECT MIN(created_at) as first_deposit_date 
             FROM vault_ledger_entries 
             WHERE user_id = $1 AND entry_type = 'DEPOSIT'`,
            [userId]
        );

        const firstDepositDate = firstDepositResult.rows[0]?.first_deposit_date;

        if (!firstDepositDate) {
            return res.json({ eligible: false });
        }

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const isEligible = new Date(firstDepositDate) < thirtyDaysAgo;
        
        res.json({ eligible: isEligible });

    } catch (error) {
        console.error("Error fetching report eligibility:", error);
        res.status(500).json({ error: 'Failed to fetch eligibility status.' });
    }
});

module.exports = router;
