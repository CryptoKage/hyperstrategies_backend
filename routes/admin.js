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
   
    console.error('Error archiving sweep:', err.message);
    res.status(500).send('Server Error');
  }
});

router.post('/distribute-profit', async (req, res) => {
  const { vault_id, total_profit_amount } = req.body;
  const adminUserId = req.user.id; // For logging
  const client = await pool.connect();

  // --- 1. Validation ---
  if (!vault_id || !total_profit_amount || parseFloat(total_profit_amount) <= 0) {
    return res.status(400).json({ message: 'Vault ID and a positive total profit amount are required.' });
  }
  
  console.log(`[Admin] Profit distribution initiated by admin ${adminUserId} for vault ${vault_id} with total profit of ${total_profit_amount}.`);

  try {
    await client.query('BEGIN');

    // --- 2. Fetch all active participants and their capital in the specified vault ---
    const { rows: participants } = await client.query(
      `SELECT user_id, tradable_capital, auto_compound 
       FROM user_vault_positions 
       WHERE vault_id = $1 AND status = 'in_trade'`,
      [vault_id]
    );

    if (participants.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No active participants found in this vault to distribute profits to.' });
    }

    // --- 3. Calculate total capital in the vault to determine ownership percentages ---
    const totalCapitalInVault = participants.reduce((sum, p) => sum + parseFloat(p.tradable_capital), 0);
    if (totalCapitalInVault <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Cannot distribute profit, total capital in vault is zero.' });
    }

    // --- 4. Loop through each participant, calculate their share, and distribute ---
    for (const participant of participants) {
      const ownershipPercentage = parseFloat(participant.tradable_capital) / totalCapitalInVault;
      const profitShare = ownershipPercentage * parseFloat(total_profit_amount);

      if (profitShare <= 0) continue; // Skip if their share is zero

      let description = '';
      if (participant.auto_compound) {
        // Add profit to their vault position (Auto-Compound ON)
        await client.query(
          'UPDATE user_vault_positions SET tradable_capital = tradable_capital + $1 WHERE user_id = $2 AND vault_id = $3',
          [profitShare, participant.user_id, vault_id]
        );
        description = `Auto-compounded ${profitShare.toFixed(2)} USDC profit in Vault ${vault_id}.`;
      } else {
        // Add profit to their main available balance (Auto-Compound OFF - "Harvest")
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
          [profitShare, participant.user_id]
        );
        description = `Harvested ${profitShare.toFixed(2)} USDC profit from Vault ${vault_id} to main balance.`;
      }

      // Log the transaction for the user's history
      await client.query(
        `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
         VALUES ($1, 'PROFIT_DISTRIBUTION', $2, $3, 'USDC', 'COMPLETED')`,
        [participant.user_id, description, profitShare]
      );
    }
    
    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully distributed $${total_profit_amount} in profits to ${participants.length} participants in vault ${vault_id}.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Admin] Profit distribution failed for vault ${vault_id}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

module.exports = router;