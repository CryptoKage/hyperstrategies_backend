// server/routes/dashboard.js
const express = require('express');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken'); // We will create this next

const router = express.Router();

// This route will be protected. It fetches all dashboard data for the logged-in user.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id; // The user ID is added to the request by our middleware

    // 1. Get user's main info (username, main balance)
    const userQuery = 'SELECT username, balance FROM users WHERE user_id = $1';
    const userResult = await pool.query(userQuery, [userId]);
    const userData = userResult.rows[0];

    // 2. Get user's vault positions
    const vaultsQuery = `
      SELECT 
        v.vault_id,
        v.name,
        uvp.amount_deposited,
        uvp.pnl
      FROM user_vault_positions uvp
      JOIN vaults v ON uvp.vault_id = v.vault_id
      WHERE uvp.user_id = $1 AND uvp.status = 'active'
    `;
    const vaultsResult = await pool.query(vaultsQuery, [userId]);
    const userVaults = vaultsResult.rows;

    // 3. Calculate total portfolio value
    const vaultTotal = userVaults.reduce((sum, vault) => sum + parseFloat(vault.amount_deposited), 0);
    const totalPortfolioValue = parseFloat(userData.balance) + vaultTotal;

    // 4. Assemble the final data package
    const dashboardData = {
      username: userData.username,
      availableBalance: parseFloat(userData.balance),
      totalPortfolioValue,
      vaults: userVaults
    };

    res.json(dashboardData);

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;

//comment to push change