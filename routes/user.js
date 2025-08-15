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

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);
const apeContract = new ethers.Contract(tokenMap.ape.address, erc20Abi, provider);

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
    const [userResult, portfolioSumsResult, bonusPointsResult] = await Promise.all([
      pool.query('SELECT balance, eth_address FROM users WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT 
           COALESCE(SUM(amount), 0) as total_capital,
           COALESCE(SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END), 0) as total_pnl
         FROM vault_ledger_entries WHERE user_id = $1`, [userId]),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);
    if (userResult.rows.length === 0) { return res.status(404).json({ error: 'User not found.' }); }
    const userData = userResult.rows[0];
    const portfolioData = portfolioSumsResult.rows[0];
    const bonusPointsData = bonusPointsResult.rows[0];
    res.json({
      address: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalCapitalInVaults: parseFloat(portfolioData.total_capital),
      totalUnrealizedPnl: parseFloat(portfolioData.total_pnl),
      totalBonusPoints: parseFloat(bonusPointsData.total_bonus_points)
    });
  } catch (err) {
    console.error('Error in /wallet endpoint:', err);
    res.status(500).send('Server Error');
  }
});


// --- THE REFACTORED /profile Endpoint ---
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [profileResult, stakedResult, pinsResult] = await Promise.all([
      // Query 1: Gets main user details (no longer selects 'tags')
      pool.query(`
        SELECT u.username, u.email, u.xp, u.referral_code, u.account_tier, COALESCE(SUM(bp.points_amount), 0) AS total_bonus_points
        FROM users u 
        LEFT JOIN bonus_points bp ON u.user_id = bp.user_id
        WHERE u.user_id = $1 
        GROUP BY u.user_id;
      `, [userId]),
      // Query 2: Gets total staked capital (unchanged)
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE user_id = $1 AND entry_type = 'DEPOSIT'", [userId]),
      // Query 3 (NEW): Fetches all pin names for the user from the new 'pins' table.
      pool.query("SELECT pin_name FROM pins WHERE owner_id = $1", [userId])
    ]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const profileData = profileResult.rows[0];
    const totalStakedCapital = parseFloat(stakedResult.rows[0].total);
    // This creates the simple array of pin names that the frontend expects.
    const userPins = pinsResult.rows.map(row => row.pin_name);

    // Combine all data into the final response, adding the new 'pins' property.
    res.json({
      ...profileData,
      total_staked_capital: totalStakedCapital,
      pins: userPins 
    });
  } catch (err) {
    console.error('Error fetching profile data:', err);
    res.status(500).send('Server Error');
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
      `SELECT eth_address, xp FROM users WHERE eth_address IS NOT NULL ORDER BY xp DESC, created_at ASC LIMIT 25`
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
    return res.status(400).json({ message: 'A referral code must be provided.' });
  }
  const sanitizedCode = desiredCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (sanitizedCode.length < 3 || sanitizedCode.length > 15) {
    return res.status(400).json({ message: 'Code must be between 3 and 15 alphanumeric characters.' });
  }
  const finalReferralCode = `HS-${sanitizedCode}`;
  try {
    const existingCodeResult = await pool.query(
      'SELECT user_id FROM users WHERE referral_code = $1',
      [finalReferralCode]
    );
    if (existingCodeResult.rows.length > 0) {
      if (existingCodeResult.rows[0].user_id !== authenticatedUserId) {
        return res.status(409).json({ message: 'This referral code is already taken. Please try another.' });
      }
      return res.status(200).json({ 
        message: 'This is already your referral code.',
        referralCode: finalReferralCode 
      });
    }
    await pool.query(
      'UPDATE users SET referral_code = $1 WHERE user_id = $2',
      [finalReferralCode, authenticatedUserId]
    );
    res.status(200).json({
      message: 'Success! Your new referral link is ready.',
      referralCode: finalReferralCode
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'This referral code was just claimed. Please try another.' });
    }
    console.error("Error updating referral code:", err.message);
    res.status(500).send('Server Error');
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

module.exports = router;
