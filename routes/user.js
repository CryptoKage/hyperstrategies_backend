// server/routes/user.js

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

// --- FINAL, ROBUST Caching Function ---
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
    // If we have NO cached price and the API fails, return a safe default instead of crashing.
    console.error('CRITICAL: Could not fetch APE price and no cache is available.');
    return 0; // Return 0 as a safe fallback
  }
}

// --- FINAL, ROBUST /wallet Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    // Fetch all data in parallel. getApePrice() will handle its own errors gracefully.
    const [usdcBalanceBigNumber, apeBalanceBigNumber, bonusPointsResult, apePriceUsd] = await Promise.all([
      usdcContract.balanceOf(userAddress),
      apeContract.balanceOf(userAddress),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      getApePrice()
    ]);
    
    const usdcBalance = ethers.utils.formatUnits(usdcBalanceBigNumber, tokenMap.usdc.decimals);
    const apeBalance = ethers.utils.formatUnits(apeBalanceBigNumber, tokenMap.ape.decimals);
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    res.json({
      address: userAddress,
      usdcBalance: parseFloat(usdcBalance),
      apeBalance: parseFloat(apeBalance),
      apePrice: apePriceUsd,
      totalBonusPoints: totalBonusPoints
    });

  } catch (err) {
    console.error('Error in /wallet endpoint:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Get User Profile Endpoint ---
// This version is the correct, up-to-date one.
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [profileResult, stakedResult] = await Promise.all([
      pool.query(`
        SELECT 
          u.username, u.email, u.xp, u.referral_code, u.account_tier,
          u.tags, -- <-- FIX: Add the new tags column here
          COALESCE(SUM(bp.points_amount), 0) AS total_bonus_points
        FROM users u
        LEFT JOIN bonus_points bp ON u.user_id = bp.user_id
        WHERE u.user_id = $1
        GROUP BY u.user_id;
      `, [userId]),
      pool.query(
        "SELECT COALESCE(SUM(tradable_capital), 0) as total FROM user_vault_positions WHERE user_id = $1 AND status IN ('in_trade', 'active')",
        [userId]
      )
    ]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const profileData = profileResult.rows[0];
    const totalStakedCapital = parseFloat(stakedResult.rows[0].total);

    res.json({
      ...profileData,
      total_staked_capital: totalStakedCapital,
    });
    
  } catch (err) {
    console.error('Error fetching profile data:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Update User Profile Endpoint ---
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // --- NEW --- Only accept username, bio is deprecated
    const { username } = req.body;

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }

    const existingUser = await pool.query(
      'SELECT user_id FROM users WHERE username = $1 AND user_id != $2',
      [username, userId]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // --- NEW --- Query no longer updates bio
    await pool.query(
      'UPDATE users SET username = $1 WHERE user_id = $2',
      [username, userId]
    );
    
    res.status(200).json({ message: 'Profile updated successfully!' });

  } catch (err) {
    console.error('Error updating profile:', err.message);
    res.status(500).send('Server Error');
  }
});


// --- Get Leaderboard Endpoint ---
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

// --- Get My Rank Endpoint ---
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

  // --- 1. Validation and Sanitization ---
  if (!desiredCode || typeof desiredCode !== 'string') {
    return res.status(400).json({ message: 'A referral code must be provided.' });
  }

  // Sanitize the input: lowercase, alphanumeric only.
  const sanitizedCode = desiredCode.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (sanitizedCode.length < 3 || sanitizedCode.length > 15) {
    return res.status(400).json({ message: 'Code must be between 3 and 15 alphanumeric characters.' });
  }

  // Our system's final referral code format.
  const finalReferralCode = `HS-${sanitizedCode}`;

  // --- 2. Database Checks and Update ---
  try {
    // Check if the user is even allowed to change their code.
    // We could add logic here later, e.g., "only changeable once" or "requires 100 XP".
    // For now, we'll allow it.

    // Check if the desired final code already exists.
    const existingCodeResult = await pool.query(
      'SELECT user_id FROM users WHERE referral_code = $1',
      [finalReferralCode]
    );

    if (existingCodeResult.rows.length > 0) {
      // If the code belongs to someone else, it's taken.
      if (existingCodeResult.rows[0].user_id !== authenticatedUserId) {
        return res.status(409).json({ message: 'This referral code is already taken. Please try another.' });
      }
      // If it belongs to the current user, it's already set. No need to update.
      return res.status(200).json({ 
        message: 'This is already your referral code.',
        referralCode: finalReferralCode 
      });
    }

    // --- 3. If all checks pass, update the database ---
    await pool.query(
      'UPDATE users SET referral_code = $1 WHERE user_id = $2',
      [finalReferralCode, authenticatedUserId]
    );

    res.status(200).json({
      message: 'Success! Your new referral link is ready.',
      referralCode: finalReferralCode
    });

  } catch (err) {
    // This will catch the UNIQUE constraint error if two users try to set the same code at the exact same time.
    if (err.code === '23505') { // PostgreSQL unique_violation error code
      return res.status(409).json({ message: 'This referral code was just claimed. Please try another.' });
    }
    console.error("Error updating referral code:", err.message);
    res.status(500).send('Server Error');
  }
});

// Add this new endpoint to server/routes/user.js

router.get('/xp-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    // The SQL query now filters OUT the daily staking bonus
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

module.exports = router;

