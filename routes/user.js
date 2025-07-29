// server/routes/user.js

const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');

// --- Setup for On-Chain Lookups ---
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);

// --- Get User Wallet Info Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get user's ETH address first.
    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    // 2. Now, make the on-chain calls and DB calls in parallel.
    const [ethBalanceBigNumber, usdcBalanceBigNumber, bonusPointsResult] = await Promise.all([
      provider.getBalance(userAddress),
      usdcContract.balanceOf(userAddress),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);
    
    // 3. Format all data.
    const ethBalance = ethers.utils.formatEther(ethBalanceBigNumber);
    const usdcBalance = ethers.utils.formatUnits(usdcBalanceBigNumber, tokenMap.usdc.decimals);
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    res.json({
      address: userAddress,
      ethBalance: parseFloat(ethBalance),
      usdcBalance: parseFloat(usdcBalance),
      totalBonusPoints: totalBonusPoints
    });

  } catch (err) {
    console.error('Error fetching wallet data:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Get User Profile Endpoint ---
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT username, email, bio, xp, referral_code FROM users WHERE user_id = $1',
      [userId]
    );
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
    const { username, bio } = req.body;

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

    await pool.query(
      'UPDATE users SET username = $1, bio = $2 WHERE user_id = $3',
      [username, bio, userId]
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
    // ✅ THE FIX: We now select eth_address as well.
    // We still select username to help the frontend identify the current user.
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

    // --- ANNOTATION: The query has been updated. ---
    // We now select both 'user_rank' and 'user_xp' from our subquery.
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
    const currentUserXp = rows[0].user_xp; // 

    res.json({ 
      rank: currentUserRank,
      xp: currentUserXp 
    });

  } catch (err) {
    console.error("Error fetching user rank:", err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;