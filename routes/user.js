// server/routes/user.js
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');
const axios = require('axios');
const erc20Abi = require('../utils/abis/erc20.json');

// --- Setup for On-Chain Lookups ---
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);
const apeContract = new ethers.Contract(tokenMap.ape.address, erc20Abi, provider);

// --- NEW --- Simple In-Memory Cache for CoinGecko Price
const priceCache = {
  apePrice: null,
  lastFetched: null,
  cacheDuration: 5 * 60 * 1000, // 5 minutes in milliseconds
};

// --- NEW --- Helper function to get the APE price, using the cache
async function getApePrice() {
  const now = Date.now();
  // If we have a cached price AND the cache is not expired, return the cached price
  if (priceCache.apePrice && priceCache.lastFetched && (now - priceCache.lastFetched < priceCache.cacheDuration)) {
    console.log('Serving APE price from cache.');
    return priceCache.apePrice;
  }
  
  // Otherwise, fetch a fresh price from the API
  console.log('Fetching fresh APE price from CoinGecko...');
  const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=apecoin&vs_currencies=usd');
  const price = response.data.apecoin.usd;
  
  // Update the cache
  priceCache.apePrice = price;
  priceCache.lastFetched = now;
  
  return price;
}

// --- Get User Wallet Info Endpoint (UPGRADED WITH CACHING) ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    // We now call our caching function instead of axios directly inside the Promise.all
    const [usdcBalanceBigNumber, apeBalanceBigNumber, bonusPointsResult, apePriceUsd] = await Promise.all([
      usdcContract.balanceOf(userAddress),
      apeContract.balanceOf(userAddress),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      getApePrice() // Use our new caching helper function
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
    // This is the catch block where the res.status(500) lives.
    // It catches errors from any of the `await` calls inside the `try` block.
    console.error('Error fetching wallet data:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Get User Profile Endpoint (UPGRADED) ---
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // --- NEW --- This query now also sums up the user's bonus points
    const profileQuery = `
      SELECT
        u.username,
        u.email,
        u.bio,
        u.xp,
        u.referral_code,
        u.account_tier,
        COALESCE(SUM(bp.points_amount), 0) AS total_bonus_points
      FROM
        users u
      LEFT JOIN
        bonus_points bp ON u.user_id = bp.user_id
      WHERE
        u.user_id = $1
      GROUP BY
        u.user_id;
    `;
    const result = await pool.query(profileQuery, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(result.rows[0]);
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

module.exports = router;