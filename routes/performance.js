// /routes/performance.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment');
const authenticateToken = require('../middleware/authenticateToken');

const BASE_INDEX_VALUE = 1000.0;

/**
 * @route   GET /api/performance/:vaultId/snapshot
 * @desc    Get a snapshot of the vault's average historical performance based on its realized P&L index.
 * @access  Public
 */
router.get('/:vaultId/snapshot', async (req, res) => {
    const { vaultId } = req.params;

    try {
        // This single, efficient query gets the very first and very last data points for the vault.
        const performanceDataResult = await pool.query(
            `
            (SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date ASC LIMIT 1)
            UNION ALL
            (SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1)
            `,
            [vaultId]
        );

        // A vault needs at least two distinct data points (a start and an end) to have a performance history.
        if (performanceDataResult.rows.length < 2) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }

        const firstRecord = performanceDataResult.rows[0];
        const lastRecord = performanceDataResult.rows[1];

        const startDate = moment(firstRecord.record_date);
        const lastIndexValue = parseFloat(lastRecord.index_value);

        // 1. Calculate the total overall performance percentage.
        const totalPerformancePercent = (lastIndexValue / BASE_INDEX_VALUE - 1) * 100;
        
        // 2. Calculate the number of days the vault has been active.
        const totalDaysActive = moment().diff(startDate, 'days');

        if (totalDaysActive <= 0) {
            // Avoid division by zero if the vault is less than a day old.
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: parseFloat(totalPerformancePercent.toFixed(2)) });
        }

        // 3. Calculate the average daily return.
        const averageDailyReturn = totalPerformancePercent / totalDaysActive;

        // 4. Extrapolate to weekly and monthly averages.
        const averageWeeklyReturn = averageDailyReturn * 7;
        const averageMonthlyReturn = averageDailyReturn * 30.4375; // Average days in a month.

        res.json({
            daily: parseFloat(averageDailyReturn.toFixed(4)),
            weekly: parseFloat(averageWeeklyReturn.toFixed(4)),
            monthly: parseFloat(averageMonthlyReturn.toFixed(4)),
            total: parseFloat(totalPerformancePercent.toFixed(2))
        });

    } catch (error) {
        console.error(`Error fetching performance snapshot for Vault ${vaultId}:`, error);
        res.status(500).json({ error: 'Failed to fetch performance snapshot.' });
    }
});

router.get('/:vaultId/user-snapshot', authenticateToken, async (req, res) => {
    const { vaultId } = req.params;
    const { id: userId } = req.user;

    try {
        const userLedgerResult = await pool.query(
            `SELECT amount, entry_type, created_at FROM vault_ledger_entries 
             WHERE user_id = $1 AND vault_id = $2 
             ORDER BY created_at ASC`,
            [userId, vaultId]
        );

        const userHistory = userLedgerResult.rows;
        if (userHistory.length === 0) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }

        const firstDepositDate = userHistory.find(e => e.entry_type === 'DEPOSIT')?.created_at;
        if (!firstDepositDate) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }

        const totalPrincipal = userHistory
            .filter(e => e.entry_type === 'DEPOSIT')
            .reduce((sum, e) => sum + parseFloat(e.amount), 0);

        const finalBalance = userHistory.reduce((sum, e) => sum + parseFloat(e.amount), 0);

        const totalPnl = finalBalance - totalPrincipal;
        const totalPerformancePercent = (totalPrincipal > 0) ? (totalPnl / totalPrincipal) * 100 : 0;
        
        const totalDaysActive = moment().diff(moment(firstDepositDate), 'days');
        if (totalDaysActive <= 0) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: parseFloat(totalPerformancePercent.toFixed(2)) });
        }

        const averageDailyReturn = totalPerformancePercent / totalDaysActive;
        const averageWeeklyReturn = averageDailyReturn * 7;
        const averageMonthlyReturn = averageDailyReturn * 30.4375;

        res.json({
            daily: parseFloat(averageDailyReturn.toFixed(2)),
            weekly: parseFloat(averageWeeklyReturn.toFixed(2)),
            monthly: parseFloat(averageMonthlyReturn.toFixed(2)),
            total: parseFloat(totalPerformancePercent.toFixed(2))
        });

    } catch (error) {
        console.error(`Error fetching USER performance snapshot for Vault ${vaultId}:`, error);
        res.status(500).json({ error: 'Failed to fetch user performance snapshot.' });
    }
});

module.exports = router;
