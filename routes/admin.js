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
    const [ userCount, totalAvailable, totalInVaults, hotWalletBalance_BN, recentDeposits, recentWithdrawals, failedSweeps, pendingVaultWithdrawals ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT SUM(balance) as total FROM users;'),
      pool.query('SELECT SUM(tradable_capital) as total FROM user_vault_positions;'),
      provider.getBalance(process.env.HOT_WALLET_ADDRESS),
      pool.query(`SELECT d.amount, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
      pool.query(`SELECT p.position_id, u.username, p.tradable_capital FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id WHERE p.status = 'sweep_failed';`),
      pool.query(`SELECT log.activity_id, log.amount_primary, log.description, u.username, log.created_at FROM user_activity_log log JOIN users u ON log.user_id = u.user_id WHERE log.activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND log.status = 'PENDING' ORDER BY log.created_at ASC;`)
    ]);

    res.json({
      userCount: parseInt(userCount.rows[0].count),
      totalAvailable: parseFloat(totalAvailable.rows[0].total || 0),
      totalInVaults: parseFloat(totalInVaults.rows[0].total || 0),
      hotWalletBalance: ethers.utils.formatEther(hotWalletBalance_BN),
      databaseConnected: true,
      alchemyConnected: true,
      recentDeposits: recentDeposits.rows,
      recentWithdrawals: recentWithdrawals.rows,
      failedSweeps: failedSweeps.rows,
      pendingVaultWithdrawals: pendingVaultWithdrawals.rows
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

// --- Endpoint to manually trigger the allocation sweep job ---
router.post('/trigger-sweep', (req, res) => {
  console.log(`[Admin] Manual sweep triggered by admin user: ${req.user.id}`);
  processAllocations();
  res.status(202).json({ message: 'Allocation sweep job has been successfully triggered. Check server logs for progress.' });
});

// --- Endpoint to retry all failed vault sweeps ---
router.post('/retry-sweeps', async (req, res) => {
  try {
    console.log(`[Admin] Retry for all failed sweeps triggered by ${req.user.id}`);
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
    console.log(`[Admin] Archiving failed sweep for position ${position_id} by ${req.user.id}`);
    const { rowCount } = await pool.query( "UPDATE user_vault_positions SET status = 'archived' WHERE position_id = $1 AND status = 'sweep_failed'", [position_id] );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Failed sweep for the given position not found.' });
    }
    res.status(200).json({ message: `Position ${position_id} has been successfully archived.` });
  } catch (err) {
    console.error('Error archiving sweep:', err.message);
    res.status(500).send('Server Error');
  }
});

// --- Endpoint for Profit Distribution (with Revenue Logging) ---
router.post('/distribute-profit', async (req, res) => {
  const { vault_id, total_profit_amount } = req.body;
  const adminUserId = req.user.id;
  const client = await pool.connect();

  if (!vault_id || !total_profit_amount || parseFloat(total_profit_amount) <= 0) {
    return res.status(400).json({ message: 'Vault ID and a positive total profit amount are required.' });
  }
  
  console.log(`[Admin] Profit distribution initiated by admin ${adminUserId} for vault ${vault_id} with total profit of ${total_profit_amount}.`);

  try {
    await client.query('BEGIN');

    const vaultResult = await client.query('SELECT performance_fee_percentage FROM vaults WHERE vault_id = $1', [vault_id]);
    if (vaultResult.rows.length === 0) throw new Error(`Vault ${vault_id} not found.`);
    const basePerfFee = parseFloat(vaultResult.rows[0].performance_fee_percentage);

    const { rows: participants } = await client.query(
      `SELECT p.user_id, p.tradable_capital, p.auto_compound, u.account_tier 
       FROM user_vault_positions p
       JOIN users u ON p.user_id = u.user_id
       WHERE p.vault_id = $1 AND p.status = 'in_trade'`,
      [vault_id]
    );

    if (participants.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No active participants found in this vault to distribute profits to.' });
    }

    const totalCapitalInVault = participants.reduce((sum, p) => sum + parseFloat(p.tradable_capital), 0);
    if (totalCapitalInVault <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Cannot distribute profit, total capital in vault is zero.' });
    }

    // --- NEW --- Variable to track total performance fee for this distribution
    let totalPerformanceFee = 0;

    for (const participant of participants) {
      const ownershipPercentage = parseFloat(participant.tradable_capital) / totalCapitalInVault;
      const grossProfitShare = ownershipPercentage * parseFloat(total_profit_amount);

      let finalPerfFee = basePerfFee;
      if (parseInt(vault_id, 10) === 2 && participant.account_tier >= 4) {
        finalPerfFee = 0.30;
      }
      
      const feeAmount = grossProfitShare * finalPerfFee;
      const netProfitForUser = grossProfitShare - feeAmount;
      
      // Add this distribution's fee to our running total
      if (feeAmount > 0) {
        totalPerformanceFee += feeAmount;
      }

      if (netProfitForUser <= 0) continue;

      let description = '';
      if (participant.auto_compound) {
        await client.query('UPDATE user_vault_positions SET tradable_capital = tradable_capital + $1 WHERE user_id = $2 AND vault_id = $3', [netProfitForUser, participant.user_id, vault_id]);
        description = `Auto-compounded ${netProfitForUser.toFixed(2)} USDC profit in Vault ${vault_id}.`;
      } else {
        await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [netProfitForUser, participant.user_id]);
        description = `Harvested ${netProfitForUser.toFixed(2)} USDC profit from Vault ${vault_id} to main balance.`;
      }

      await client.query(
        `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'PROFIT_DISTRIBUTION', $2, $3, 'USDC', 'COMPLETED')`,
        [participant.user_id, description, netProfitForUser]
      );
    }
    
    // --- NEW --- After the loop, log the single, total performance fee revenue
    if (totalPerformanceFee > 0) {
        const revenueNote = `Total performance fee from ${participants.length} users in vault ${vault_id}.`;
        await client.query(
            `INSERT INTO platform_revenue (source, amount, notes, related_vault_id) VALUES ('PERFORMANCE_FEE', $1, $2, $3)`,
            [totalPerformanceFee, revenueNote, vault_id]
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

// @route   GET /api/admin/users/search
// @desc    Search for users by username, email, or wallet address
// @access  Admin
router.get('/users/search', async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 3) {
    return res.status(400).json({ message: 'Search query must be at least 3 characters long.' });
  }

  try {
    const searchQuery = `
      SELECT user_id, username, email, eth_address 
      FROM users 
      WHERE 
        username ILIKE $1 OR 
        email ILIKE $1 OR 
        eth_address ILIKE $1
      LIMIT 10;
    `;
    const { rows } = await pool.query(searchQuery, [`%${query}%`]);
    res.json(rows);
  } catch (err) {
    console.error('Admin user search error:', err);
    res.status(500).send('Server Error');
  }
});

router.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const [userDetails, userPositions, userActivity] = await Promise.all([
      pool.query('SELECT * FROM users WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM user_vault_positions WHERE user_id = $1 ORDER BY entry_date DESC', [userId]),
      pool.query('SELECT * FROM user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId])
    ]);

    if (userDetails.rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const { password_hash, encrypted_private_key, ...safeUserDetails } = userDetails.rows[0];
    
    res.json({
      details: safeUserDetails,
      positions: userPositions.rows,
      activity: userActivity.rows
    });

  } catch (err) {
    console.error(`Error fetching details for user ${userId}:`, err);
    res.status(500).send('Server Error');
  }
});

// @route   GET /api/admin/deposits
// @desc    Get a paginated list of all deposits
// @access  Admin
router.get('/deposits', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;
    const searchTerm = req.query.search || '';

    let query = `
      SELECT d.id, d.user_id, u.username, u.email, d.amount, d.token, d.tx_hash, d.detected_at
      FROM deposits d JOIN users u ON d.user_id = u.user_id
    `;
    const queryParams = [];
    if (searchTerm) {
      query += ` WHERE u.username ILIKE $1 OR u.email ILIKE $1 OR d.tx_hash ILIKE $1`;
      queryParams.push(`%${searchTerm}%`);
    }
    query += ` ORDER BY detected_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const totalResult = await pool.query('SELECT COUNT(*) FROM deposits;');
    const { rows: deposits } = await pool.query(query, queryParams);

    res.json({
      deposits,
      totalCount: parseInt(totalResult.rows[0].count, 10),
      totalPages: Math.ceil(parseInt(totalResult.rows[0].count, 10) / limit),
      currentPage: page
    });
  } catch (err) {
    console.error('Error fetching deposits for admin:', err);
    res.status(500).send('Server Error');
  }
});

// @route   GET /api/admin/vault-positions
// @desc    Get a paginated list of all user vault positions
// @access  Admin
router.get('/vault-positions', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    // This query joins with the users and vaults tables to get names
    const positionsQuery = `
      SELECT
        uvp.position_id,
        uvp.user_id,
        u.username,
        uvp.vault_id,
        v.name as vault_name,
        uvp.tradable_capital,
        uvp.status,
        uvp.lock_expires_at,
        uvp.entry_date
      FROM
        user_vault_positions uvp
      JOIN
        users u ON uvp.user_id = u.user_id
      JOIN
        vaults v ON uvp.vault_id = v.vault_id
      ORDER BY
        uvp.entry_date DESC
      LIMIT $1 OFFSET $2;
    `;
    
    const totalResult = await pool.query('SELECT COUNT(*) FROM user_vault_positions;');
    const totalPositions = parseInt(totalResult.rows[0].count, 10);
    
    const { rows: positions } = await pool.query(positionsQuery, [limit, offset]);

    res.json({
      positions,
      totalCount: totalPositions,
      totalPages: Math.ceil(totalPositions / limit),
      currentPage: page
    });

  } catch (err) {
    console.error('Error fetching vault positions for admin:', err);
    res.status(500).send('Server Error');
  }
});

router.get('/users/:userId/bonus-points', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId]);
    res.json({ totalBonusPoints: parseFloat(result.rows[0].total_bonus_points) });
  } catch (err) {
    console.error(`Error fetching bonus points for user ${userId}:`, err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;