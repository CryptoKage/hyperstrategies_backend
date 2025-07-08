// server/routes/dashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // We will fetch all necessary data in parallel for maximum speed
    const [userResult, vaultsResult, bonusPointsResult] = await Promise.all([
      // Query 1: Get user's name, balance, and deposit address
      pool.query('SELECT username, balance, eth_address FROM users WHERE user_id = $1', [userId]),
      
      // Query 2: Get all vaults and the user's position in them
      pool.query(`
        SELECT 
          v.vault_id, v.name, v.description, v.strategy_type,
          COALESCE(uvp.tradable_capital, 0) AS tradable_capital,
          COALESCE(uvp.pnl, 0) AS pnl
        FROM vaults v
        LEFT JOIN user_vault_positions uvp ON v.vault_id = uvp.vault_id AND uvp.user_id = $1
      `, [userId]),
      
      // Query 3: Get the sum of the user's bonus points safely
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);

    // Check if we found a user
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userData = userResult.rows[0];
    const allVaults = vaultsResult.rows;
    // This will now be a number (e.g., 0) even if the user has no points, preventing null errors.
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    // --- Calculate All Financial Metrics ---
    
    // 1. Get total capital invested in vaults
    const vaultTotal = allVaults.reduce((sum, vault) => sum + parseFloat(vault.tradable_capital), 0);
    
    // 2. Total portfolio value is now the sum of their available balance, what's in the vaults, AND the value of their bonus points.
    const totalPortfolioValue = parseFloat(userData.balance) + vaultTotal + totalBonusPoints;

    // --- Assemble the Final Data Package for the Frontend ---
    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address, // Include the deposit address
      availableBalance: parseFloat(userData.balance),
      totalPortfolioValue,
      totalBonusPoints, // Include the bonus points total
      vaults: allVaults
    };

    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;