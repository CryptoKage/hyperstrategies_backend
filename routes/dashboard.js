// server/routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // --- We now fetch all ledger-based data in parallel ---
    const [
      userResult, 
      vaultsResult, 
      userPositionsResult,
      bonusPointsResult
    ] = await Promise.all([
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),
      pool.query("SELECT * FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),
      // --- NEW LEDGER-BASED QUERY for user positions ---
      pool.query(`
        SELECT
          vle.vault_id,
          COALESCE(SUM(vle.amount), 0) as tradable_capital,
          COALESCE(SUM(CASE WHEN vle.entry_type IN ('PNL_UPDATE', 'PNL_DISTRIBUTION') THEN vle.amount ELSE 0 END), 0) as pnl,
          uvs.auto_compound
        FROM vault_ledger_entries vle
        LEFT JOIN user_vault_settings uvs ON vle.user_id = uvs.user_id AND vle.vault_id = uvs.vault_id
        WHERE vle.user_id = $1
        GROUP BY vle.vault_id, uvs.auto_compound
        HAVING SUM(vle.amount) > 0.000001 -- Only return vaults where the user has a positive balance
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

    // Calculate aggregate stats from the user's positions
    const totalCapitalInVaults = userPositions.reduce((sum, pos) => sum + pos.tradable_capital, 0);
    const totalUnrealizedPnl = userPositions.reduce((sum, pos) => sum + pos.pnl, 0);
    
    const dashboardData = {
      username: userData.username,
      depositAddress: userData.eth_address,
      availableBalance: parseFloat(userData.balance),
      totalBonusPoints: totalBonusPoints,
      accountTier: userData.account_tier,
      vaults: availableVaults,
      userPositions: userPositions, // This now includes the auto_compound flag
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
