// server/routes/admin.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');
const { processAllocations } = require('../jobs/processAllocations');

router.use(authenticateToken, isAdmin);

// --- Get Full Admin Dashboard Stats Endpoint ---
router.get('/dashboard-stats', async (req, res) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const [
      userCount, totalAvailable, totalInVaults, pendingWithdrawals, 
      hotWalletBalance_BN, recentDeposits, recentWithdrawals, failedSweeps
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT SUM(balance) as total FROM users;'),
      pool.query('SELECT SUM(tradable_capital) as total FROM user_vault_positions;'),
      pool.query(`SELECT COUNT(*) FROM withdrawal_queue WHERE status = 'queued';`),
      provider.getBalance(process.env.HOT_WALLET_ADDRESS),
      pool.query(`SELECT d.amount, d.token, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, w.token, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
      pool.query(`SELECT p.position_id, u.username, p.tradable_capital FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id WHERE p.status = 'sweep_failed';`)
    ]);

    res.json({
      userCount: parseInt(userCount.rows[0].count),
      totalAvailable: parseFloat(totalAvailable.rows[0].total || 0),
      totalInVaults: parseFloat(totalInVaults.rows[0].total || 0),
      pendingWithdrawals: parseInt(pendingWithdrawals.rows[0].count),
      hotWalletBalance: ethers.utils.formatEther(hotWalletBalance_BN),
      databaseConnected: true,
      alchemyConnected: true,
      recentDeposits: recentDeposits.rows,
      recentWithdrawals: recentWithdrawals.rows,
      failedSweeps: failedSweeps.rows
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

// --- Endpoint to manually trigger the allocation sweep job ---
router.post('/trigger-sweep', (req, res) => {
  console.log(`[Admin] Manual sweep triggered by admin user: ${req.user.username}`);
  processAllocations();
  res.status(202).json({ message: 'Allocation sweep job has been successfully triggered. Check server logs for progress.' });
});

// --- Endpoint to retry all failed vault sweeps ---
router.post('/retry-sweeps', async (req, res) => {
  try {
    console.log(`[Admin] Retry for all failed sweeps triggered by ${req.user.username}`);
    const { rowCount } = await pool.query("UPDATE user_vault_positions SET status = 'active' WHERE status = 'sweep_failed'");
    res.status(200).json({ message: `Successfully re-queued ${rowCount} failed allocation(s).` });
  } catch (err) {
    console.error('Error retrying sweeps:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Endpoint to ignore/archive a single failed sweep ---
router.post('/archive-sweep/:position_id', async (req, res) => {
  try {
    const { position_id } = req.params;
    console.log(`[Admin] Archiving failed sweep for position ${position_id} by ${req.user.username}`);
    const { rowCount } = await pool.query(
      "UPDATE user_vault_positions SET status = 'archived' WHERE position_id = $1 AND status = 'sweep_failed'",
      [position_id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Failed sweep for the given position not found, or it was not in a failed state.' });
    }
    res.status(200).json({ message: `Position ${position_id} has been successfully archived.` });
  } catch (err) {
    // ✅ THE FIX: The catch block now has the correct syntax.
    console.error('Error archiving sweep:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;