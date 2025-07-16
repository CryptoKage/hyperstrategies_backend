// server/routes/admin.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');
const { processAllocations } = require('../jobs/processAllocations'); // Import the job function

// Protect all routes in this file with both checks
router.use(authenticateToken, isAdmin);


// --- Get Admin Dashboard Stats Endpoint ---
router.get('/dashboard-stats', async (req, res) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

    const [
      userCount,
      totalAvailable,
      totalInVaults,
      pendingWithdrawals,
      hotWalletBalance_BN,
      recentDeposits,
      recentWithdrawals
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT SUM(balance) as total FROM users;'),
      pool.query('SELECT SUM(tradable_capital) as total FROM user_vault_positions;'),
      pool.query(`SELECT COUNT(*) FROM withdrawal_queue WHERE status = 'queued';`),
      provider.getBalance(process.env.HOT_WALLET_ADDRESS),
      pool.query(`SELECT d.amount, d.token, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, w.token, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`)
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
    });

  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ 
      error: "Failed to fetch admin stats",
      databaseConnected: false,
      alchemyConnected: false
    });
  }
});


// --- ✅ NEW: Endpoint to manually trigger the allocation sweep ---
router.post('/trigger-sweep', async (req, res) => {
  console.log(`[Admin] Manual sweep triggered by admin user: ${req.user.username}`);
  
  // We call the function but DO NOT wait for it to finish (don't use await).
  // This allows us to send an immediate response back to the admin UI.
  // The job will run in the background.
  processAllocations(); 
  
  res.status(202).json({ message: 'Allocation sweep job has been successfully triggered. Check server logs for progress.' });
});


module.exports = router;