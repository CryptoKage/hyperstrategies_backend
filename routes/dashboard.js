// server/routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      userResult, 
      vaultsResult, 
      userPositionsResult,
      bonusPointsResult
    ] = await Promise.all([
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),
      pool.query("SELECT vault_id, name, description, status, image_url, fee_percentage, is_fee_tier_based, risk_level, display_pnl_percentage FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),
      
      // --- THIS IS THE CORRECTED QUERY ---
      pool.query(`
        WITH UserPositions AS (
          SELECT
            vle.vault_id,
            SUM(vle.amount) as tradable_capital,
            SUM(CASE WHEN vle.entry_type = 'PNL_DISTRIBUTION' THEN vle.amount ELSE 0 END) as pnl
          FROM vault_ledger_entries vle
          WHERE vle.user_id = $1
          GROUP BY vle.vault_id
        )
        SELECT
          up.vault_id,
          up.tradable_capital,
          up.pnl,
          COALESCE(uvs.auto_compound, true) as auto_compound
        FROM UserPositions up
        LEFT JOIN user_vault_settings uvs ON up.vault_id = uvs.vault_id AND uvs.user_id = $1
        WHERE up.tradable_capital > 0.000001
      `, [userId]),

      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userData = userResult.rows[0];
    const availableVaults = vaultsResult.rows;
    const userPositions = userPositionsResult.rows.map(p => ({
      ...p,
      tradable_capital: parseFloat(p.tradable_capital),
      pnl: parseFloat(p.pnl)
    }));
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    const totalCapitalInVaults = userPositions.reduce((sum, pos) => sum + pos.tradable_capital, 0);
    const totalUnrealizedPnl = userPositions.reduce((sum, pos) => sum + pos.pnl, 0);
    
    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalBonusPoints: totalBonusPoints,
      accountTier: userData.account_tier,
      vaults: availableVaults,
      userPositions: userPositions,
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
