const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/total-xp-awarded', async (req, res) => {
  try {

    const result = await pool.query(
      `SELECT COALESCE(SUM(amount_primary), 0) as total 
       FROM user_activity_log 
       WHERE activity_type LIKE 'XP_%' AND status IN ('CLAIMED', 'COMPLETED')`
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
