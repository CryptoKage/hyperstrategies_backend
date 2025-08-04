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

  if (!vault_id || !total_profit_amount || isNaN(parseFloat(total_profit_amount))) {
    return res.status(400).json({ message: 'Vault ID and a valid total profit amount are required.' });
  }
  
  const totalProfit_BN = ethers.utils.parseUnits(total_profit_amount.toString(), 6);
  
  console.log(`[Admin] Profit distribution initiated by ${adminUserId} for vault ${vault_id} with total profit of ${total_profit_amount}.`);

  try {
    await client.query('BEGIN');

    const vaultResult = await client.query('SELECT performance_fee_percentage FROM vaults WHERE vault_id = $1', [vault_id]);
    if (vaultResult.rows.length === 0) throw new Error(`Vault ${vault_id} not found.`);
    const basePerfFee = parseFloat(vaultResult.rows[0].performance_fee_percentage);

    const { rows: participants } = await client.query(
      `SELECT p.position_id, p.user_id, p.tradable_capital, p.high_water_mark, p.auto_compound, u.account_tier 
       FROM user_vault_positions p
       JOIN users u ON p.user_id = u.user_id
       WHERE p.vault_id = $1 AND p.status = 'in_trade'`,
      [vault_id]
    );

    if (participants.length === 0) { /* ... (error handling) */ }

    const totalCapitalInVault_BN = participants.reduce(
      (sum, p) => sum.add(ethers.utils.parseUnits(p.tradable_capital.toString(), 6)), 
      ethers.BigNumber.from(0)
    );

    if (totalCapitalInVault_BN.isZero()) { /* ... (error handling) */ }
    
    let totalPerformanceFee = 0;

    for (const participant of participants) {
      const participantCapital_BN = ethers.utils.parseUnits(participant.tradable_capital.toString(), 6);
      
      // Calculate user's gross profit share using high-precision math
      const grossProfitShare_BN = totalProfit_BN.mul(participantCapital_BN).div(totalCapitalInVault_BN);

      const currentHWM_BN = ethers.utils.parseUnits(participant.high_water_mark.toString(), 6);
      const newEquity_BN = participantCapital_BN.add(grossProfitShare_BN);

      let feeAmount_BN = ethers.BigNumber.from(0);
      let netProfitForUser_BN = grossProfitShare_BN;
      let newHighWaterMark_BN = currentHWM_BN;

      // --- HIGH-WATER MARK LOGIC ---
      if (newEquity_BN.gt(currentHWM_BN)) {
        // Profit was made above the previous high point
        const billableProfit_BN = newEquity_BN.sub(currentHWM_BN);
        
        let finalPerfFee = basePerfFee;
        if (parseInt(vault_id, 10) === 2 && participant.account_tier >= 4) {
          finalPerfFee = 0.30;
        }
        
        // Calculate fee only on the billable profit
        const feeMultiplier = Math.round(finalPerfFee * 100);
        feeAmount_BN = billableProfit_BN.mul(feeMultiplier).div(100);
        netProfitForUser_BN = grossProfitShare_BN.sub(feeAmount_BN);
        
        // The new high-water mark is the new equity
        newHighWaterMark_BN = newEquity_BN;

        if (feeAmount_BN.gt(0)) {
          totalPerformanceFee += parseFloat(ethers.utils.formatUnits(feeAmount_BN, 6));
        }
      }
      
      if (netProfitForUser_BN.isNegative()) { // Should not happen with HWM, but as a safeguard
          netProfitForUser_BN = ethers.BigNumber.from(0);
      }
      
      // Update user balances/positions and log activity
      if (participant.auto_compound) {
        const newCapital_BN = participantCapital_BN.add(netProfitForUser_BN);
        await client.query(
          'UPDATE user_vault_positions SET tradable_capital = $1, high_water_mark = $2 WHERE position_id = $3',
          [ethers.utils.formatUnits(newCapital_BN, 6), ethers.utils.formatUnits(newHighWaterMark_BN, 6), participant.position_id]
        );
        // ... (logging)
      } else {
        await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [ethers.utils.formatUnits(netProfitForUser_BN, 6), participant.user_id]);
        await client.query('UPDATE user_vault_positions SET high_water_mark = $1 WHERE position_id = $2', [ethers.utils.formatUnits(newHighWaterMark_BN, 6), participant.position_id]);
        // ... (logging)
      }
    }
    
    // --- Log total performance fee revenue ---
    if (totalPerformanceFee > 0) {
      // ... (revenue logging logic)
    }
    
       if (totalPerformanceFee > 0) {
      const splits = {
        'TREASURY_FOUNDATION': 0.60,
        'OPERATIONS_DEVELOPMENT': 0.25,
        'TRADING_TEAM_BONUS': 0.10,
        'COMMUNITY_GROWTH_INCENTIVES': 0.05
      };

      const revenueNote = `Performance fee from ${participants.length} users in vault ${vault_id}.`;
      
      // Update the main performance fee ledger
      await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'PERFORMANCE_FEES_TOTAL'`, [totalPerformanceFee]);
      await client.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'PERFORMANCE_FEES_TOTAL'), $1, $2)`, [totalPerformanceFee, revenueNote]);
      
      // Split the total fee into the sub-ledgers
      for (const ledgerName in splits) {
        const splitAmount = totalPerformanceFee * splits[ledgerName];
        if (splitAmount > 0) {
          await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = $2`, [splitAmount, ledgerName]);
          const splitDesc = `Allocated ${splits[ledgerName]*100}% of performance fee to ${ledgerName}.`;
          await client.query(
            `INSERT INTO treasury_transactions (from_ledger_id, to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'PERFORMANCE_FEES_TOTAL'), (SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = $1), $2, $3)`,
            [ledgerName, splitAmount, splitDesc]
          );
        }
      }
    }



    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully distributed profits...` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Admin] Profit distribution failed for vault ${vault_id}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

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

router.get('/treasury-report', async (req, res) => {
  try {
    const [
      depositFeeRevenueResult,
      performanceFeeRevenueResult,
      totalCapitalInVaultsResult,
      totalOutstandingBonusPointsResult
    ] = await Promise.all([
      // Sum up all revenue from deposit fees
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM platform_revenue WHERE source = 'DEPOSIT_FEE'"),
      // Sum up all revenue from performance fees
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM platform_revenue WHERE source = 'PERFORMANCE_FEE'"),
      // Calculate total user capital currently in vaults (a liability)
      pool.query("SELECT COALESCE(SUM(tradable_capital), 0) as total FROM user_vault_positions WHERE status = 'in_trade'"),
      // Calculate total outstanding bonus points (a future liability)
      pool.query("SELECT COALESCE(SUM(points_amount), 0) as total FROM bonus_points")
    ]);

    const depositFeeRevenue = parseFloat(depositFeeRevenueResult.rows[0].total);
    const performanceFeeRevenue = parseFloat(performanceFeeRevenueResult.rows[0].total);
    const totalCapitalInVaults = parseFloat(totalCapitalInVaultsResult.rows[0].total);
    const totalOutstandingBonusPoints = parseFloat(totalOutstandingBonusPointsResult.rows[0].total);

    res.json({
      revenue: {
        depositFees: depositFeeRevenue,
        performanceFees: performanceFeeRevenue,
        total: depositFeeRevenue + performanceFeeRevenue
      },
      liabilities: {
        userCapitalInVaults: totalCapitalInVaults,
        bonusPoints: totalOutstandingBonusPoints
      },
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

// @route   GET /api/admin/vaults/:vaultId/details
// @desc    Get detailed information for a single vault and all its participants
// @access  Admin
// @route   GET /api/admin/vaults/:vaultId/details (UPGRADED)
router.get('/vaults/:vaultId/details', async (req, res) => {
  const { vaultId } = req.params;
  try {
    const [vaultDetailsResult, participantsResult] = await Promise.all([
      pool.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      pool.query( `SELECT p.position_id, u.user_id, u.username, p.tradable_capital, p.pnl, p.high_water_mark, p.auto_compound, p.status FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id WHERE p.vault_id = $1 ORDER BY u.username ASC`, [vaultId] )
    ]);

    if (vaultDetailsResult.rows.length === 0) {
      return res.status(404).json({ message: 'Vault not found.' });
    }

    const vaultDetails = vaultDetailsResult.rows[0];
    const participants = participantsResult.rows;

    const totalCapital = participants.reduce((sum, p) => sum + parseFloat(p.tradable_capital), 0);
    const totalPnl = participants.reduce((sum, p) => sum + parseFloat(p.pnl), 0);
    
    // --- NEW --- Calculate the current average PnL percentage
    const currentPnlPercentage = (totalCapital > 0) ? (totalPnl / totalCapital) * 100 : 0;
    
    res.json({
      vault: vaultDetails,
      participants: participants,
      stats: {
        participantCount: participants.length,
        totalCapital: totalCapital,
        totalPnl: totalPnl,
        currentPnlPercentage: currentPnlPercentage // Add to response
      }
    });
  } catch (err) {
    console.error(`Error fetching details for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  }
});

// @route   POST /api/admin/vaults/:vaultId/update-pnl
// @desc    Update the PnL for all participants in a vault by a percentage
// @access  Admin
router.post('/vaults/:vaultId/update-pnl', async (req, res) => {
  const { vaultId } = req.params;
  const { pnlPercentage } = req.body;
  const client = await pool.connect();

  const pnlPercent = parseFloat(pnlPercentage);
  if (isNaN(pnlPercent)) {
    return res.status(400).json({ message: 'A valid number for PnL percentage is required.' });
  }

  try {
    await client.query('BEGIN');

    // Get all active positions to update
    const { rows: positions } = await client.query(
      `SELECT position_id, tradable_capital FROM user_vault_positions WHERE vault_id = $1 AND status = 'in_trade'`,
      [vaultId]
    );

    if (positions.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No active positions found in this vault to update.' });
    }

    // Loop through each position and update its PnL
    for (const position of positions) {
      const capital = parseFloat(position.tradable_capital);
      const newPnlValue = capital * (pnlPercent / 100.0);

      await client.query(
        'UPDATE user_vault_positions SET pnl = $1 WHERE position_id = $2',
        [newPnlValue, position.position_id]
      );
    }
    
    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully updated PnL for ${positions.length} positions in vault ${vaultId} to ${pnlPercent}%.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error updating PnL for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

module.exports = router;