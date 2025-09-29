// /routes/performance.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment');
const authenticateToken = require('../middleware/authenticateToken');

const BASE_INDEX_VALUE = 1000.0;

// This route for the VAULT's overall performance is now definitively correct.
router.get('/:vaultId/snapshot', async (req, res) => {
    const { vaultId } = req.params;
    try {
        const performanceDataResult = await pool.query(
            `(SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date ASC LIMIT 1)
             UNION ALL
             (SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1)`,
            [vaultId]
        );
        if (performanceDataResult.rows.length < 2) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }
        const firstRecord = performanceDataResult.rows[0];
        const lastRecord = performanceDataResult.rows[1];

        const startDate = moment(firstRecord.record_date);
        const endDate = moment(lastRecord.record_date); // <-- We use the date of the last record
        const lastIndexValue = parseFloat(lastRecord.index_value);
        const totalPerformancePercent = (lastIndexValue / BASE_INDEX_VALUE - 1) * 100;
        
        // --- THE DEFINITIVE FIX: Calculate duration based on the actual data window ---
        const totalMillisecondsActive = endDate.diff(startDate, 'milliseconds');
        const totalDaysActive = totalMillisecondsActive / (1000 * 60 * 60 * 24);
        // --- END OF FIX ---

        if (totalDaysActive <= 0) {
            // This handles cases where all performance happens within a single day.
            return res.json({ daily: totalPerformancePercent, weekly: totalPerformancePercent, monthly: totalPerformancePercent, total: totalPerformancePercent });
        }

        const averageDailyReturn = totalPerformancePercent / totalDaysActive;
        res.json({
            daily: averageDailyReturn,
            weekly: averageDailyReturn * 7,
            monthly: averageDailyReturn * 30.4375,
            total: totalPerformancePercent
        });
    } catch (error) {
        console.error(`Error fetching performance snapshot for Vault ${vaultId}:`, error);
        res.status(500).json({ error: 'Failed to fetch performance snapshot.' });
    }
});

// This route for the USER's performance is also now definitively correct.
router.get('/:vaultId/user-snapshot', authenticateToken, async (req, res) => {
    const { vaultId } = req.params;
    const { id: userId } = req.user;
    try {
        const userLedgerResult = await pool.query(`SELECT amount, entry_type, created_at FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [userId, vaultId]);
        const userHistory = userLedgerResult.rows;
        if (userHistory.length === 0) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }
        const firstDepositDate = userHistory.find(e => e.entry_type === 'DEPOSIT')?.created_at;
        if (!firstDepositDate) {
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: 0 });
        }

        const totalPrincipal = userHistory.filter(e => e.entry_type === 'DEPOSIT').reduce((sum, e) => sum + parseFloat(e.amount), 0);
        const totalPnl = userHistory.filter(e => e.entry_type.includes('PNL')).reduce((sum, e) => sum + parseFloat(e.amount), 0);
        const totalPerformancePercent = (totalPrincipal > 0) ? (totalPnl / totalPrincipal) * 100 : 0;
        
        // --- THE DEFINITIVE FIX: Calculate duration based on the user's personal activity window ---
        const lastEventDate = userHistory[userHistory.length - 1].created_at;
        const totalMillisecondsActive = moment(lastEventDate).diff(moment(firstDepositDate), 'milliseconds');
        const totalDaysActive = totalMillisecondsActive / (1000 * 60 * 60 * 24);
        // --- END OF FIX ---

        if (totalDaysActive <= 0) {
            return res.json({ daily: totalPerformancePercent, weekly: totalPerformancePercent, monthly: totalPerformancePercent, total: totalPerformancePercent });
        }

        const averageDailyReturn = totalPerformancePercent / totalDaysActive;
        res.json({
            daily: averageDailyReturn,
            weekly: averageDailyReturn * 7,
            monthly: averageDailyReturn * 30.4375,
            total: totalPerformancePercent
        });
    } catch (error) {
        console.error(`Error fetching USER performance snapshot for Vault ${vaultId}:`, error);
        res.status(500).json({ error: 'Failed to fetch user performance snapshot.' });
    }
});

module.exports = router;
