// /routes/dashboard.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const moment = require('moment');

const BASE_INDEX_VALUE = 1000.0;

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch all data in parallel
    const [
      userResult,
      vaultsResult,
      userPositionsResult,
      bonusPointsResult,
      pendingCheckResult,
      // --- THE FIX: Fetch the raw index data; we will process it in JS ---
      allPerformanceDataResult
    ] = await Promise.all([
      pool.query('SELECT username, balance, eth_address, account_tier FROM users WHERE user_id = $1', [userId]),
      pool.query("SELECT vault_id, name, description, status, image_url, fee_percentage, is_fee_tier_based, risk_level FROM vaults WHERE status IN ('active', 'coming_soon') ORDER BY vault_id ASC"),
      pool.query(`WITH UserPositions AS (SELECT vle.vault_id, SUM(vle.amount) as tradable_capital, SUM(CASE WHEN vle.entry_type = 'PNL_DISTRIBUTION' THEN vle.amount ELSE 0 END) as pnl FROM vault_ledger_entries vle WHERE vle.user_id = $1 GROUP BY vle.vault_id) SELECT up.vault_id, up.tradable_capital, up.pnl, COALESCE(uvs.auto_compound, true) as auto_compound FROM UserPositions up LEFT JOIN user_vault_settings uvs ON up.vault_id = uvs.vault_id AND uvs.user_id = $1 WHERE up.tradable_capital > 0.000001`, [userId]),
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]),
      pool.query(`SELECT EXISTS (SELECT 1 FROM user_activity_log WHERE user_id = $1 AND activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND status IS NOT NULL AND status NOT IN ('COMPLETED', 'FAILED')) as has_pending`, [userId]),
      pool.query(`SELECT vault_id, record_date, index_value FROM vault_performance_index ORDER BY vault_id, record_date ASC`)
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // --- THE FIX: A more robust way to process performance data ---
    const performanceByVault = allPerformanceDataResult.rows.reduce((acc, row) => {
        if (!acc[row.vault_id]) {
            acc[row.vault_id] = [];
        }
        acc[row.vault_id].push(row);
        return acc;
    }, {});

    const performanceMap = {};
    for (const vaultId in performanceByVault) {
        const history = performanceByVault[vaultId];
        if (history.length >= 2) {
            const firstRecord = history[0];
            const lastRecord = history[history.length - 1];
            const totalPerformancePercent = (parseFloat(lastRecord.index_value) / BASE_INDEX_VALUE - 1) * 100;
            const totalDaysActive = moment(lastRecord.record_date).diff(moment(firstRecord.record_date), 'days');
            const avgMonthlyReturn = (totalDaysActive > 0) ? (totalPerformancePercent / totalDaysActive) * 30.4375 : 0;
            performanceMap[vaultId] = { monthly: parseFloat(avgMonthlyReturn.toFixed(2)), total: parseFloat(totalPerformancePercent.toFixed(2)) };
        }
    }
    
    const availableVaults = vaultsResult.rows.map(vault => ({
        ...vault,
        performance: performanceMap[vault.vault_id] || { monthly: 0, total: 0 }
    }));
    
    // ... (The rest of your data assembly is correct and unchanged)
    const userData = userResult.rows[0];
    const userPositions = userPositionsResult.rows.map(p => ({...p, tradable_capital: parseFloat(p.tradable_capital), pnl: parseFloat(p.pnl)}));
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);
    const totalCapitalInVaults = userPositions.reduce((sum, pos) => sum + pos.tradable_capital, 0);
    const totalUnrealizedPnl = userPositions.reduce((sum, pos) => sum + pos.pnl, 0);
    const dashboardData = { username: userData.username, depositAddress: userData.eth_address, availableBalance: parseFloat(userData.balance), totalBonusPoints, accountTier: userData.account_tier, vaults: availableVaults, userPositions, totalCapitalInVaults, totalUnrealizedPnl, pendingVaultWithdrawal: pendingCheckResult.rows[0].has_pending };

    res.json(dashboardData);
    
  } catch (err) {
    console.error('Dashboard route error:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
