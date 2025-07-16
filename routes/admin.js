// server/routes/admin.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers'); // Import ethers directly
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');

// ✅ THE FIX: Create the provider directly in this file, removing the need for the broken import.
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

router.use(authenticateToken, isAdmin);

router.get('/dashboard-stats', async (req, res) => {
  try {
    // We no longer need to call getProvider()
    const [
      userCount,
      totalAvailable,
      totalInVaults,
      pendingWithdrawals,
      recentDeposits,
      recentWithdrawals,
      hotWalletBalance_BN
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT SUM(balance) as total FROM users;'),
      pool.query('SELECT SUM(tradable_capital) as total FROM user_vault_positions;'),
      pool.query(`SELECT COUNT(*) FROM withdrawal_queue WHERE status = 'queued';`),
      pool.query(`SELECT d.amount, d.token, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, w.token, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
      provider.getBalance(process.env.HOT_WALLET_ADDRESS)
    ]);

    res.json({
      userCount: parseInt(userCount.rows[0].count),
      totalAvailable: parseFloat(totalAvailable.rows[0].total || 0),
      totalInVaults: parseFloat(totalInVaults.rows[0].total || 0),
      pendingWithdrawals: parseInt(pendingWithdrawals.rows[0].count),
      hotWalletBalance: ethers.utils.formatEther(hotWalletBalance_BN),
      alchemyConnected: true,
      databaseConnected: true,
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

module.exports = router;