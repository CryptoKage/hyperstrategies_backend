// server/routes/dashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  console.time('FullDashboardRoute'); // Start a timer for the whole route
  try {
    const userId = req.user.id;

    // We will fetch all necessary data in parallel for maximum speed
    const [userResult, vaultsResult, bonusPointsResult] = await Promise.all([
      // Query 1: Get user's name, balance, and deposit address
      (async () => {
        console.time('UserQuery');
        const result = await pool.query('SELECT username, balance, eth_address FROM users WHERE user_id = $1', [userId]);
        console.timeEnd('UserQuery');
        return result;
      })(),
      
      // Query 2: Get all vaults and the user's position in them
      (async () => {
        console.time('VaultsQuery');
        const result = await pool.query(`
          SELECT 
            v.vault_id, v.name, v.description, v.strategy_description, v.risk_level, v.status,
            COALESCE(uvp.tradable_capital, 0) AS tradable_capital,
            COALESCE(uvp.pnl, 0) AS pnl
          FROM vaults v
          LEFT JOIN user_vault_positions uvp ON v.vault_id = uvp.vault_id AND uvp.user_id = $1
        `, [userId]);
        console.timeEnd('VaultsQuery');
        return result;
      })(),
      
      // Query 3: Get the sum of the user's bonus points safely
      (async () => {
        console.time('BonusPointsQuery');
        const result = await pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]);
        console.timeEnd('BonusPointsQuery');
        return result;
      })()
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userData = userResult.rows[0];
    const allVaults = vaultsResult.rows;
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    const vaultTotal = allVaults.reduce((sum, vault) => sum + parseFloat(vault.tradable_capital), 0);
    const totalPortfolioValue = parseFloat(userData.balance) + vaultTotal + totalBonusPoints;

    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalPortfolioValue,
      totalBonusPoints,
      vaults: allVaults
    };

    console.timeEnd('FullDashboardRoute'); // Stop the timer for the whole route
    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    console.timeEnd('FullDashboardRoute'); // Also log time if there's an error
    res.status(500).send('Server Error');
  }
});

module.exports = router;