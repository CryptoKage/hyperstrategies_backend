// server/routes/dashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');


router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get basic user info
    const userQuery = 'SELECT username, balance FROM users WHERE user_id = $1';
    const userResult = await pool.query(userQuery, [userId]);
    const userData = userResult.rows[0];

    // 2. Get all vaults + optional user data
    const vaultsQuery = `
      SELECT 
        v.vault_id,
        v.name,
        v.description,
        v.strategy_type,
        v.status,
        v.max_cap,
        v.wallet_address,
        COALESCE(uvp.tradable_capital, 0) AS tradable_capital,
        COALESCE(uvp.pnl, 0) AS pnl
      FROM vaults v
      LEFT JOIN user_vault_positions uvp
        ON uvp.vault_id = v.vault_id AND uvp.user_id = $1
    `;
    const vaultsResult = await pool.query(vaultsQuery, [userId]);
    const allVaults = vaultsResult.rows;

    // 3. Total portfolio = user balance + all vault deposits
    const vaultTotal = allVaults.reduce((sum, vault) => sum + parseFloat(vault.tradable_capital), 0);
    const totalPortfolioValue = parseFloat(userData.balance) + vaultTotal;

    const dashboardData = {
      username: userData.username,
      availableBalance: parseFloat(userData.balance),
      totalPortfolioValue,
      vaults: allVaults
    };

    res.json(dashboardData);
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
