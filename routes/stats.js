// /routes/stats.js

const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/total-xp-awarded', async (req, res) => {
  try {
    // --- THE DEFINITIVE QUERY: Sum XP from both sources ---
    // This query runs two sub-queries in parallel and adds their results together.
    const result = await pool.query(`
      SELECT
        (SELECT COALESCE(SUM(xp), 0) FROM users) -- 1. Get all XP from the main user table
        +
        (SELECT COALESCE(SUM(amount_primary), 0) -- 2. Get all UNCLAIMED XP from the activity log
         FROM user_activity_log
         WHERE activity_type LIKE 'XP_%' AND status = 'UNCLAIMED')
      AS total;
    `);
    // --- END OF DEFINITIVE QUERY ---
    
    res.json({
      totalXpAwarded: parseFloat(result.rows[0].total)
    });

  } catch (error) {
    console.error("Error fetching total XP awarded:", error);
    res.status(500).json({ error: 'Failed to fetch total XP stat.' });
  }
});

router.get('/buyback-pool', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            // Fetch the pool balance and the total supply of bonus points in parallel
            const [poolResult, totalPointsResult] = await Promise.all([
                client.query("SELECT balance FROM treasury_ledgers WHERE ledger_name = 'FARMING_BUYBACK_POOL'"),
                client.query("SELECT COALESCE(SUM(points_amount), 0) as total FROM bonus_points")
            ]);

            const poolBalance = poolResult.rows.length > 0 ? parseFloat(poolResult.rows[0].balance) : 0;
            const totalBonusPoints = parseFloat(totalPointsResult.rows[0].total);

            res.status(200).json({
                poolBalance: poolBalance,
                totalBonusPoints: totalBonusPoints
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error("Error fetching buyback pool stats:", error);
        res.status(500).json({ error: 'Failed to fetch buyback pool statistics.' });
    }
});


// --- Endpoint to get the monthly history of farming profits ---
router.get('/farming-profits', async (req, res) => {
    try {
        // This query finds all transactions going INTO the buyback pool,
        // extracts the month, and sums the amounts for each month.
        const query = `
            SELECT 
                to_char(t.created_at, 'YYYY-MM') as month,
                SUM(t.amount) as monthly_profit
            FROM treasury_transactions t
            JOIN treasury_ledgers l ON t.to_ledger_id = l.ledger_id
            WHERE l.ledger_name = 'FARMING_BUYBACK_POOL'
            GROUP BY to_char(t.created_at, 'YYYY-MM')
            ORDER BY month DESC;
        `;
        
        const { rows } = await pool.query(query);
        
        // Format the data into a simple object like { "2025-10": 10000, "2025-09": 40 }
        const monthlyProfits = rows.reduce((acc, row) => {
            acc[row.month] = parseFloat(row.monthly_profit);
            return acc;
        }, {});

        res.status(200).json(monthlyProfits);

    } catch (error) {
        console.error("Error fetching farming profit history:", error);
        res.status(500).json({ error: 'Failed to fetch farming profit history.' });
    }
});

module.exports = router;
