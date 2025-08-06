// server/routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // --- We run all queries in parallel for maximum efficiency ---
    const [
      userResult, 
      vaultsResult, 
      positionsResult, 
      bonusPointsResult,
      // --- NEW EFFICIENT QUERY ---
      // This single query gets the two sums we need, replacing the old 'reduce' logic.
      portfolioSumsResult 
    ] = await Promise.all([
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),
      pool.query("SELECT * FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),
      pool.query('SELECT * FROM user_vault_positions WHERE user_id = $1', [userId]),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      // --- NEW QUERY DEFINITION ---
      pool.query(
        `SELECT 
           COALESCE(SUM(tradable_capital), 0) as total_capital, 
           COALESCE(SUM(pnl), 0) as total_pnl 
         FROM user_vault_positions 
         WHERE user_id = $1 AND status IN ('in_trade', 'active')`,
        [userId]
      )
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userData = userResult.rows[0];
    const availableVaults = vaultsResult.rows;
    const userPositions = positionsResult.rows;
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    // --- Extracting the new values from our new query ---
    const totalCapitalInVaults = parseFloat(portfolioSumsResult.rows[0].total_capital);
    const totalUnrealizedPnl = parseFloat(portfolioSumsResult.rows[0].total_pnl);
    
    // --- Constructing the final JSON payload ---
    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalBonusPoints: totalBonusPoints,
      accountTier: userData.account_tier,
      vaults: availableVaults,
      userPositions: userPositions,
      // --- ADDING THE NEW FIELDS FOR THE FRONTEND ---
      totalCapitalInVaults: totalCapitalInVaults,
      totalUnrealizedPnl: totalUnrealizedPnl
    };

    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;