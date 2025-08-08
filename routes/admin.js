// server/routes/admin.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');
// Note: We no longer need processAllocations here

router.use(authenticateToken, isAdmin);

// --- Get Full Admin Dashboard Stats Endpoint (Ledger-Based) ---
router.get('/dashboard-stats', async (req, res) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const [ userCount, totalAvailable, totalInVaultsResult, hotWalletBalance_BN, recentDeposits, recentWithdrawals, pendingVaultWithdrawals ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users;'),
      pool.query('SELECT COALESCE(SUM(balance), 0) as total FROM users;'),
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries"),
      provider.getBalance(process.env.HOT_WALLET_ADDRESS),
      pool.query(`SELECT d.amount, u.username, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, u.username, w.created_at FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
      pool.query(`SELECT log.activity_id, log.amount_primary, log.description, u.username, log.created_at FROM user_activity_log log JOIN users u ON log.user_id = u.user_id WHERE log.activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND log.status = 'PENDING' ORDER BY log.created_at ASC;`)
    ]);

    res.json({
      userCount: parseInt(userCount.rows[0].count),
      totalAvailable: parseFloat(totalAvailable.rows[0].total || 0),
      totalInVaults: parseFloat(totalInVaultsResult.rows[0].total || 0),
      hotWalletBalance: ethers.utils.formatEther(hotWalletBalance_BN),
      databaseConnected: true,
      alchemyConnected: true,
      recentDeposits: recentDeposits.rows,
      recentWithdrawals: recentWithdrawals.rows,
      failedSweeps: [], // Deprecated
      pendingVaultWithdrawals: pendingVaultWithdrawals.rows
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

// --- NEW Endpoint for DISPLAY-ONLY PnL Updates ---
router.post('/vaults/:vaultId/update-display-pnl', async (req, res) => {
  const { vaultId } = req.params;
  const { pnlPercentage } = req.body;
  const pnlPercent = parseFloat(pnlPercentage);

  if (isNaN(pnlPercent)) {
    return res.status(400).json({ message: 'A valid number for PnL percentage is required.' });
  }
  try {
    const { rowCount } = await pool.query('UPDATE vaults SET display_pnl_percentage = $1 WHERE vault_id = $2', [pnlPercent, vaultId]);
    if (rowCount === 0) { return res.status(404).json({ message: 'Vault not found.' }); }
    res.status(200).json({ message: `Successfully updated display PnL for vault ${vaultId} to ${pnlPercent}%.` });
  } catch (err) {
    console.error(`Error updating display PnL for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  }
});

// --- Endpoint for Finalizing a Period and Distributing Real PnL ---
router.post('/vaults/:vaultId/finalize-pnl', async (req, res) => {
  const { vaultId } = req.params;
  const { newTotalValue } = req.body;
  const client = await pool.connect();
  try {
    const newVaultValue = parseFloat(newTotalValue);
    if (isNaN(newVaultValue) || newVaultValue < 0) {
      return res.status(400).json({ message: 'A valid, non-negative number is required.' });
    }
    await client.query('BEGIN');
    const currentCapitalResult = await client.query("SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1", [vaultId]);
    const currentTotalCapital = parseFloat(currentCapitalResult.rows[0].total);
    if (currentTotalCapital <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Vault has no capital to distribute PnL for.' });
    }
    const totalGainOrLoss = newVaultValue - currentTotalCapital;
    if (Math.abs(totalGainOrLoss) < 0.000001) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'New value is the same as the current value. No PnL to distribute.' });
    }
    const participantsResult = await client.query(`SELECT user_id, COALESCE(SUM(amount), 0) as user_capital FROM vault_ledger_entries WHERE vault_id = $1 GROUP BY user_id HAVING SUM(amount) > 0`, [vaultId]);
    const participants = participantsResult.rows;
    for (const participant of participants) {
      const userCapital = parseFloat(participant.user_capital);
      const userShare = userCapital / currentTotalCapital;
      const userPnl = totalGainOrLoss * userShare;
      await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount) VALUES ($1, $2, 'PNL_DISTRIBUTION', $3)`, [participant.user_id, vaultId, userPnl]);
      const description = `Realized PnL of ${userPnl.toFixed(2)} USDC distributed for Vault ${vaultId}.`;
      await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_PNL_DISTRIBUTION', $2, $3, 'USDC', 'COMPLETED')`, [participant.user_id, description, userPnl]);
    }
    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully finalized PnL for ${participants.length} participants. Total distributed: $${totalGainOrLoss.toFixed(2)}.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error finalizing PnL for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

router.post('/vaults/:vaultId/harvest', async (req, res) => {
  const { vaultId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const usersToHarvestResult = await client.query(
      `SELECT user_id FROM user_vault_settings WHERE vault_id = $1 AND auto_compound = false`,
      [vaultId]
    );
    const userIdsToHarvest = usersToHarvestResult.rows.map(r => r.user_id);

    if (userIdsToHarvest.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'No users with auto-compound disabled found in this vault.' });
    }

    let totalHarvestedAmount = 0;
    
    for (const userId of userIdsToHarvest) {
      // Get all PNL entries that have not been harvested yet.
      // We do this by summing ALL PNL, then subtracting all HARVESTS.
      const pnlResult = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END), 0) as total_pnl,
                COALESCE(SUM(CASE WHEN entry_type = 'PNL_HARVEST' THEN amount ELSE 0 END), 0) as total_harvested
         FROM vault_ledger_entries
         WHERE user_id = $1 AND vault_id = $2`,
        [userId, vaultId]
      );
      
      const userPnlToHarvest = parseFloat(pnlResult.rows[0].total_pnl) + parseFloat(pnlResult.rows[0].total_harvested);

      if (userPnlToHarvest > 0.000001) { // Use a small threshold for floating point math
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
          [userPnlToHarvest, userId]
        );
        await client.query(
          `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount)
           VALUES ($1, $2, 'PNL_HARVEST', $3)`,
          [userId, vaultId, -userPnlToHarvest]
        );
        const description = `Harvested ${userPnlToHarvest.toFixed(2)} USDC profit from Vault ${vaultId} to main balance.`;
        await client.query(
            `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
             VALUES ($1, 'VAULT_PNL_HARVEST', $2, $3, 'USDC', 'COMPLETED')`,
            [userId, description, userPnlToHarvest]
        );
        totalHarvestedAmount += userPnlToHarvest;
      }
    }
    
    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully harvested a total of $${totalHarvestedAmount.toFixed(2)} for ${userIdsToHarvest.length} users.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error during profit harvesting for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
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

router.get('/treasury-report', async (req, res) => {
  try {
    // --- THE FIX ---
    // We now fetch all ledger balances and liability data in one go.
    const [
      ledgersResult, // 1. Get all ledger balances from the correct table.
      totalCapitalInVaultsResult,
      totalOutstandingBonusPointsResult
    ] = await Promise.all([
      pool.query("SELECT ledger_name, balance FROM treasury_ledgers"),
      pool.query("SELECT COALESCE(SUM(tradable_capital), 0) as total FROM user_vault_positions WHERE status = 'in_trade'"),
      pool.query("SELECT COALESCE(SUM(points_amount), 0) as total FROM bonus_points")
    ]);

    // 2. Transform the array of ledger rows into a simple key-value map for easy access.
    //    Example: { "DEPOSIT_FEES_TOTAL": 150.50, "PERFORMANCE_FEES_TOTAL": 2500.00, ... }
    const ledgersMap = ledgersResult.rows.reduce((acc, row) => {
      acc[row.ledger_name] = parseFloat(row.balance);
      return acc;
    }, {});

    // 3. Construct the final report using the new ledgersMap.
    const depositFeeRevenue = ledgersMap['DEPOSIT_FEES_TOTAL'] || 0;
    const performanceFeeRevenue = ledgersMap['PERFORMANCE_FEES_TOTAL'] || 0;
    const totalCapitalInVaults = parseFloat(totalCapitalInVaultsResult.rows[0].total);
    const totalOutstandingBonusPoints = parseFloat(totalOutstandingBonusPointsResult.rows[0].total);

    res.json({
      // The frontend needs this "revenue" object.
      revenue: {
        depositFees: depositFeeRevenue,
        performanceFees: performanceFeeRevenue,
        total: depositFeeRevenue + performanceFeeRevenue
      },
      // This part was already working correctly.
      liabilities: {
        userCapitalInVaults: totalCapitalInVaults,
        bonusPoints: totalOutstandingBonusPoints
      },
      // CRITICAL: The frontend NEEDS this "ledgers" object to populate the allocation cards.
      ledgers: ledgersMap,
      // The net position calculation remains the same.
      netPosition: (depositFeeRevenue + performanceFeeRevenue) - totalOutstandingBonusPoints
    });

  } catch (err) {
    console.error('Error fetching treasury report:', err);
    res.status(500).send('Server Error');
  }
});

router.post('/buyback-points', async (req, res) => {
  const { buybackAmountUSD } = req.body;
  const adminUserId = req.user.id;
  const client = await pool.connect();

  const amountToBuyBack = parseFloat(buybackAmountUSD);
  if (!amountToBuyBack || amountToBuyBack <= 0) {
    return res.status(400).json({ message: 'A positive amount is required.' });
  }

  try {
    await client.query('BEGIN');

    // 1. Check if the treasury has enough funds in the buyback ledgers
    const buybackLedgersResult = await client.query(
      `SELECT SUM(balance) as total FROM treasury_ledgers WHERE ledger_name IN ('COMMUNITY_GROWTH_INCENTIVES', 'DEPOSIT_FEES_BUYBACK')`
    );
    const availableBuybackFunds = parseFloat(buybackLedgersResult.rows[0].total);

    if (availableBuybackFunds < amountToBuyBack) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Insufficient funds for buyback. Available: $${availableBuybackFunds.toFixed(2)}` });
    }

    // 2. Fetch all users who have bonus points and the total amount of points
    const { rows: pointHolders } = await client.query(`
        SELECT user_id, SUM(points_amount) as total_points
        FROM bonus_points
        GROUP BY user_id
        HAVING SUM(points_amount) > 0
    `);
    const totalOutstandingPoints = pointHolders.reduce((sum, holder) => sum + parseFloat(holder.total_points), 0);
    
    if (totalOutstandingPoints === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No outstanding bonus points to buy back.' });
    }
    
    // 3. Loop through each holder, calculate their share, and process the buy-back
    for (const holder of pointHolders) {
      const ownershipPercentage = parseFloat(holder.total_points) / totalOutstandingPoints;
      const userBuybackAmount = amountToBuyBack * ownershipPercentage;
      
      const xpToAward = userBuybackAmount * 0.1;
      
      // Credit user's main balance with USDC
      await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [userBuybackAmount, holder.user_id]);
      // Debit their bonus points by inserting a negative transaction
      await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [holder.user_id, -userBuybackAmount]);
      // Award XP and re-calculate tier
      const userXpResult = await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2 RETURNING xp', [xpToAward, holder.user_id]);
      const { calculateUserTier } = require('../utils/tierUtils');
      const newTier = calculateUserTier(parseFloat(userXpResult.rows[0].xp));
      await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newTier, holder.user_id]);
      
      // Log for user's history
      const description = `Platform bought back ${userBuybackAmount.toFixed(2)} Bonus Points for ${userBuybackAmount.toFixed(2)} USDC.`;
      await client.query( `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, amount_secondary, symbol_secondary, status) VALUES ($1, 'BONUS_POINT_BUYBACK', $2, $3, 'USDC', $4, 'XP', 'COMPLETED')`, [holder.user_id, description, userBuybackAmount, xpToAward]);
    }
    
    // 4. Log the expense in the treasury
    const expenseDesc = `Bonus Point Buy-Back of $${amountToBuyBack.toFixed(2)} initiated by admin ${adminUserId}.`;
    await client.query(`UPDATE treasury_ledgers SET balance = balance - $1 WHERE ledger_name = 'COMMUNITY_GROWTH_INCENTIVES'`, [amountToBuyBack]); // Assuming we pull from this ledger first
    await client.query(`INSERT INTO treasury_transactions (from_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'COMMUNITY_GROWTH_INCENTIVES'), $1, $2)`, [amountToBuyBack, expenseDesc]);

    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully executed buy-back of $${amountToBuyBack.toFixed(2)} across ${pointHolders.length} users.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Admin] Bonus Point buy-back failed:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});


module.exports = router;
