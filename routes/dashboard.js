// /routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const moment = require('moment'); // We'll need moment.js

const BASE_INDEX_VALUE = 1000.0;

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      userResult, 
      vaultsResult, 
      userPositionsResult,
      bonusPointsResult,
      pendingCheckResult,
      // --- THE FIX: Fetch all performance data in one go ---
      allPerformanceDataResult
    ] = await Promise.all([
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),
      pool.query("SELECT vault_id, name, description, status, image_url, fee_percentage, is_fee_tier_based, risk_level FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),
      pool.query(`
        WITH UserPositions AS ( /* ... your existing query is correct and unchanged ... */ )
        SELECT /* ... */ FROM UserPositions /* ... */
      `, [userId]),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      pool.query(`SELECT EXISTS (...) as has_pending`, [userId]), // Truncated for clarity
      // --- THIS IS THE NEW QUERY ---
      pool.query(`
        SELECT
          vault_id,
          MIN(record_date) as start_date,
          (ARRAY_AGG(index_value ORDER BY record_date DESC))[1] as last_index
        FROM vault_performance_index
        GROUP BY vault_id
      `)
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // --- THE FIX: Process the performance data into a simple map ---
    const performanceMap = allPerformanceDataResult.rows.reduce((acc, row) => {
        const totalPerformancePercent = (parseFloat(row.last_index) / BASE_INDEX_VALUE - 1) * 100;
        const totalDaysActive = moment().diff(moment(row.start_date), 'days');
        const avgMonthlyReturn = (totalDaysActive > 0) ? (totalPerformancePercent / totalDaysActive) * 30.4375 : 0;
        
        acc[row.vault_id] = {
            monthly: parseFloat(avgMonthlyReturn.toFixed(2)),
            total: parseFloat(totalPerformancePercent.toFixed(2)),
        };
        return acc;
    }, {});
    
    const userData = userResult.rows[0];
    
    // --- THE FIX: Attach the performance data to each vault object ---
    const availableVaults = vaultsResult.rows.map(vault => ({
        ...vault,
        performance: performanceMap[vault.vault_id] || { monthly: 0, total: 0 }
    }));
    
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
      totalUnrealizedPnl: totalUnrealizedPnl,
      pendingVaultWithdrawal: pendingCheckResult.rows[0].has_pending
    };

    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
