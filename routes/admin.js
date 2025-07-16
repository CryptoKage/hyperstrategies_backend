// server/routes/admin.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');

// Protect all routes in this file with both checks
router.use(authenticateToken, isAdmin);

router.get('/dashboard-stats', async (req, res) => {
  try {
    const [
      userCount,
      totalAvailable,
      totalInVaults,
      pendingWithdrawals,
      recentDeposits,
      recentWithdrawals
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT SUM(balance) as total FROM users;'),
      pool.query('SELECT SUM(tradable_capital) as total FROM user_vault_positions;'),
      pool.query(`SELECT COUNT(*) FROM withdrawal_queue WHERE status = 'queued';`),
      pool.query(`SELECT d.amount, d.token, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, w.token, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
    ]);

    res.json({
      userCount: parseInt(userCount.rows[0].count),
      totalAvailable: parseFloat(totalAvailable.rows[0].total),
      totalInVaults: parseFloat(totalInVaults.rows[0].total),
      pendingWithdrawals: parseInt(pendingWithdrawals.rows[0].count),
      recentDeposits: recentDeposits.rows,
      recentWithdrawals: recentWithdrawals.rows,
    });

  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;