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

module.exports = router;
