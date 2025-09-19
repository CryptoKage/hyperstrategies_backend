// /routes/performance.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment');

const BASE_INDEX_VALUE = 1000.0;

/**
 * @route   GET /api/performance/:vaultId/snapshot
 * @desc    Get a snapshot of the vault's average historical performance.
 * @access  Public
 */
router.get('/:vaultId/snapshot', async (req, res) => {
    const { vaultId } = req.params;

    try {
        // 1. Get the first and last performance index records to find the start date and total performance.
        const performanceDataResult = await pool.query(
            ` (SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date ASC LIMIT 1)
              UNION ALL
              (SELECT record_date, index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1)`,
            [vaultId]
        );

        if (performanceDataResult.rows.length < 2) {
            // Not enough data to calculate performance
            return res.json({
                daily: 0,
                weekly: 0,
                monthly: 0,
                total: 0
            });
        }

        const firstRecord = performanceDataResult.rows[0];
        const lastRecord = performanceDataResult.rows[1];

        const startDate = moment(firstRecord.record_date);
        const endDate = moment(lastRecord.record_date);
        const lastIndexValue = parseFloat(lastRecord.index_value);

        // 2. Calculate the total performance and duration.
        const totalPerformancePercent = (lastIndexValue / BASE_INDEX_VALUE - 1) * 100;
        const totalDaysActive = endDate.diff(startDate, 'days');

        if (totalDaysActive <= 0) {
            // Avoid division by zero if all events are on the same day.
            return res.json({ daily: 0, weekly: 0, monthly: 0, total: totalPerformancePercent });
        }

        // 3. Calculate the average daily return.
        const averageDailyReturn = totalPerformancePercent / totalDaysActive;

        // 4. Extrapolate to weekly and monthly averages.
        const averageWeeklyReturn = averageDailyReturn * 7;
        const averageMonthlyReturn = averageDailyReturn * 30.4375; // Average days in a month

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

module.exports = router;
