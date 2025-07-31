// server/routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // --- ANNOTATION --- We'll use Promise.all to run our database queries in parallel.
    // This is much more efficient than running them one after another.

    const [userResult, vaultsResult, positionsResult, bonusPointsResult] = await Promise.all([
      // Query 1: Get user data, including the new account_tier
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),

      // Query 2: Get all available vaults, filtered and ordered correctly
     pool.query("SELECT * FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),

      // Query 3: Get all of the user's specific vault positions with all details
      pool.query('SELECT * FROM user_vault_positions WHERE user_id = $1', [userId]),
      
      // Query 4: Get total bonus points
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);

    // --- ANNOTATION --- Error handling and data extraction
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userData = userResult.rows[0];
    const availableVaults = vaultsResult.rows;
    const userPositions = positionsResult.rows;
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    // --- ANNOTATION --- Calculations for total value
    const investedValue = userPositions.reduce((sum, position) => sum + parseFloat(position.tradable_capital), 0);
    const totalPortfolioValue = parseFloat(userData.balance) + investedValue;

    // --- ANNOTATION --- Constructing the final JSON payload
    // This structure now matches exactly what the new frontend components expect.
    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalPortfolioValue: totalPortfolioValue,
      totalBonusPoints: totalBonusPoints,
      accountTier: userData.account_tier, // The user's tier level
      vaults: availableVaults,             // The list of all available vaults (ordered and filtered)
      userPositions: userPositions        // The user's specific positions with lock_expires_at etc.
    };

    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;