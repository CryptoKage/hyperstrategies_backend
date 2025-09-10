
// START: PASTE THIS ENTIRE BLOCK into your new routes/stats.js FILE
const express = require('express');
const router = express.Router();
const pool = require('../db');

// --- GET Endpoint: Calculate the sum of all XP ever awarded ---
router.get('/total-xp-awarded', async (req, res) => {
  try {
    // We only sum up entries from the activity log that are related to XP.
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount_primary), 0) as total 
       FROM user_activity_log 
       WHERE activity_type LIKE 'XP_%'`
    );
    
    res.json({
      totalXpAwarded: parseFloat(result.rows[0].total)
    });

  } catch (error) {
    console.error("Error fetching total XP awarded:", error);
    res.status(500).json({ error: 'Failed to fetch total XP stat.' });
  }
});

module.exports = router;
