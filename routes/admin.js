const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');
const { sweepDepositsToTradingDesk } = require('../jobs/sweepDeposits');
const { processLedgerSweeps } = require('../jobs/processLedgerSweeps');

// Authenticate first, then verify admin status via asynchronous DB lookup.
router.use(authenticateToken);
router.use(isAdmin);

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
      pool.query(`SELECT log.activity_id, log.user_id, log.amount_primary, log.description, u.username, log.created_at FROM user_activity_log log JOIN users u ON log.user_id = u.user_id WHERE log.activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND log.status = 'PENDING' ORDER BY log.created_at ASC;`)
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
      pendingVaultWithdrawals: pendingVaultWithdrawals.rows
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

// --- Manual PnL Application Endpoint ---
router.post('/vaults/:vaultId/apply-manual-pnl', async (req, res) => {
  const { vaultId } = req.params;
  const { pnlPercentage, beforeTimestamp } = req.body;
  const client = await pool.connect();
  try {
    const pnlPercent = parseFloat(pnlPercentage);
    if (isNaN(pnlPercent)) { return res.status(400).json({ message: 'A valid PnL percentage is required.' }); }
    if (!beforeTimestamp || !new Date(beforeTimestamp).getTime()) { return res.status(400).json({ message: 'A valid "before timestamp" is required.' }); }
    await client.query('BEGIN');
    const participantsResult = await client.query(
      `SELECT user_id, COALESCE(SUM(CASE WHEN entry_type NOT IN ('PNL_DISTRIBUTION') THEN amount ELSE 0 END), 0) as principal
       FROM vault_ledger_entries WHERE vault_id = $1 AND created_at < $2 GROUP BY user_id HAVING COALESCE(SUM(CASE WHEN entry_type NOT IN ('PNL_DISTRIBUTION') THEN amount ELSE 0 END), 0) > 0`,
      [vaultId, beforeTimestamp]
    );
    const participants = participantsResult.rows;
    if (participants.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'No eligible participants found before the specified time.' });
    }
    for (const participant of participants) {
      const principal = parseFloat(participant.principal);
      const pnlAmount = principal * (pnlPercent / 100.0);
      if (Math.abs(pnlAmount) > 0.000001) {
        await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount) VALUES ($1, $2, 'PNL_DISTRIBUTION', $3)`,[participant.user_id, vaultId, pnlAmount]);
        const description = `Distributed ${pnlPercent}% PnL ($${pnlAmount.toFixed(2)}) for Vault ${vaultId}.`;
        await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_PNL_DISTRIBUTION', $2, $3, 'USDC', 'COMPLETED')`,[participant.user_id, description, pnlAmount]);
      }
    }
    await client.query('UPDATE vaults SET display_pnl_percentage = display_pnl_percentage + $1 WHERE vault_id = $2', [pnlPercent, vaultId]);
    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully applied ${pnlPercent}% PnL to ${participants.length} eligible participants.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error applying manual PnL for vault ${vaultId}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
  }
});

// --- Vault Details Endpoint (Ledger-Based) ---
router.get('/vaults/:vaultId/details', async (req, res) => {
    const { vaultId } = req.params;
    try {
        const vaultDetailsResult = await pool.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]);
        if (vaultDetailsResult.rows.length === 0) { return res.status(404).json({ message: 'Vault not found.' }); }
        const vaultDetails = vaultDetailsResult.rows[0];

        // --- THIS IS THE DEFINITIVE, CORRECTED QUERY ---
        const participantsResult = await pool.query(
            `WITH UserTotals AS (
              SELECT
                user_id,
                SUM(amount) as total_capital,
                SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END) as pnl
              FROM vault_ledger_entries
              WHERE vault_id = $1
              GROUP BY user_id
            )
            SELECT
              ut.user_id,
              u.username,
              ut.total_capital,
              ut.pnl,
              (ut.total_capital - ut.pnl) as principal -- Principal is calculated correctly here
            FROM UserTotals ut
            JOIN users u ON ut.user_id = u.user_id
            WHERE ut.total_capital > 0.000001 -- Only show users with a current balance
            ORDER BY u.username ASC`,
            [vaultId]
        );

        const participants = participantsResult.rows.map(p => ({
            ...p,
            total_capital: parseFloat(p.total_capital),
            principal: parseFloat(p.principal),
            pnl: parseFloat(p.pnl)
        }));

        const totalCapital = participants.reduce((sum, p) => sum + p.total_capital, 0);
        const totalPnl = participants.reduce((sum, p) => sum + p.pnl, 0);
        const totalPrincipal = totalCapital - totalPnl;
        const currentPnlPercentage = (totalPrincipal > 0) ? (totalPnl / totalPrincipal) * 100 : 0;
        
        res.json({
            vault: vaultDetails,
            participants: participants,
            stats: {
                participantCount: participants.length,
                totalCapital: totalCapital,
                totalPnl: totalPnl,
                currentPnlPercentage: currentPnlPercentage
            }
        });
    } catch (err) {
        console.error(`Error fetching ledger-based details for vault ${vaultId}:`, err);
        res.status(500).send('Server Error');
    }
});

router.get('/users/search', async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 3) {
    return res.status(400).json({ message: 'Search query must be at least 3 characters long.' });
  }
  try {
    const searchQuery = `SELECT user_id, username, email, eth_address FROM users WHERE username ILIKE $1 OR email ILIKE $1 OR eth_address ILIKE $1 LIMIT 10;`;
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
    // --- THE FIX: We now run one extra query to get the pins ---
    const [userDetails, userVaults, userActivity, bonusPoints, userPins] = await Promise.all([
      // Query 1: Gets main user details (no longer selects 'tags')
      pool.query('SELECT user_id, username, email, eth_address, xp, account_tier, referral_code, created_at, balance FROM users WHERE user_id = $1', [userId]),
      // Query 2: Gets vault positions (unchanged)
      pool.query(`SELECT v.name as vault_name, vle.vault_id, SUM(vle.amount) as total_capital FROM vault_ledger_entries vle JOIN vaults v ON vle.vault_id = v.vault_id WHERE vle.user_id = $1 GROUP BY vle.vault_id, v.name HAVING SUM(vle.amount) > 0.000001`, [userId]),
      // Query 3: Gets activity log (unchanged)
      pool.query('SELECT * FROM user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
      // Query 4: Gets bonus points (unchanged)
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total FROM bonus_points WHERE user_id = $1', [userId]),
      // Query 5 (NEW): Fetches all pin names for the user from the new 'pins' table.
      pool.query("SELECT pin_name FROM pins WHERE owner_id = $1", [userId])
    ]);

    if (userDetails.rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Combine the results into the final payload
    const fullUserDetails = { 
      ...userDetails.rows[0], 
      total_bonus_points: parseFloat(bonusPoints.rows[0].total),
      // --- THE FIX: Add the 'pins' array to the response ---
      pins: userPins.rows.map(p => p.pin_name) 
    };
    
    res.json({
      details: fullUserDetails,
      positions: userVaults.rows.map(p => ({...p, total_capital: parseFloat(p.total_capital)})),
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

router.get('/vault-positions', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    const positionsQuery = `
      SELECT
        vle.user_id,
        u.username,
        vle.vault_id,
        v.name as vault_name,
        SUM(vle.amount) as total_capital
      FROM vault_ledger_entries vle
      JOIN users u ON vle.user_id = u.user_id
      JOIN vaults v ON vle.vault_id = v.vault_id
      GROUP BY vle.user_id, u.username, vle.vault_id, v.name
      HAVING SUM(vle.amount) > 0.000001
      ORDER BY u.username
      LIMIT $1 OFFSET $2;
    `;
    // Get a correct count of total positions
    const totalResult = await pool.query(`
      SELECT COUNT(*) FROM (
        SELECT 1 FROM vault_ledger_entries GROUP BY user_id, vault_id HAVING SUM(amount) > 0.000001
      ) as positions
    `);
    const { rows: positions } = await pool.query(positionsQuery, [limit, offset]);
    
    res.json({
      positions,
      totalCount: parseInt(totalResult.rows[0].count, 10),
      totalPages: Math.ceil(parseInt(totalResult.rows[0].count, 10) / limit),
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
    const [ledgersResult, totalCapitalInVaultsResult, totalOutstandingBonusPointsResult] = await Promise.all([
      pool.query("SELECT ledger_name, balance FROM treasury_ledgers"),
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries"),
      pool.query("SELECT COALESCE(SUM(points_amount), 0) as total FROM bonus_points")
    ]);
    const ledgersMap = ledgersResult.rows.reduce((acc, row) => { acc[row.ledger_name] = parseFloat(row.balance); return acc; }, {});
    const depositFeeRevenue = ledgersMap['DEPOSIT_FEES_TOTAL'] || 0;
    const performanceFeeRevenue = ledgersMap['PERFORMANCE_FEES_TOTAL'] || 0;
    const totalCapitalInVaults = parseFloat(totalCapitalInVaultsResult.rows[0].total);
    const totalOutstandingBonusPoints = parseFloat(totalOutstandingBonusPointsResult.rows[0].total);
    res.json({
      revenue: { depositFees: depositFeeRevenue, performanceFees: performanceFeeRevenue, total: depositFeeRevenue + performanceFeeRevenue },
      liabilities: { userCapitalInVaults: totalCapitalInVaults, bonusPoints: totalOutstandingBonusPoints },
      ledgers: ledgersMap,
      netPosition: (depositFeeRevenue + performanceFeeRevenue) - totalOutstandingBonusPoints
    });
  } catch (err) {
    console.error('Error fetching treasury report:', err);
    res.status(500).send('Server Error');
  }
});
  
router.post('/trigger-sweep', (req, res) => {
  console.log(`[ADMIN] Manual capital sweep triggered by admin user: ${req.user.id}`);
  processLedgerSweeps(); 
  res.status(202).json({ message: 'Capital sweep job has been successfully triggered. Check server logs for progress.' });
});

// --- NEW Endpoint for an Admin to Approve a Vault Withdrawal ---
router.post('/approve-withdrawal/:activityId', async (req, res) => {
  const { activityId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const requestResult = await client.query(
      `SELECT user_id, amount_primary, description FROM user_activity_log WHERE activity_id = $1 AND activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND status = 'PENDING'`,
      [activityId]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending withdrawal request not found or already processed.' });
    }
    const request = requestResult.rows[0];
    const { user_id, description } = request;
    const vaultIdMatch = description.match(/from Vault (\d+)/);
    const vaultId = vaultIdMatch ? parseInt(vaultIdMatch[1], 10) : null;
    if (!vaultId) throw new Error('Could not parse vault ID from withdrawal description.');
    
    await client.query(
      `UPDATE vault_ledger_entries SET status = 'PENDING_PROCESS' WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'WITHDRAWAL_REQUEST' AND status = 'PENDING_APPROVAL'`,
      [user_id, vaultId]
    );
    await client.query("UPDATE user_activity_log SET status = 'PROCESSING' WHERE activity_id = $1", [activityId]);
    await client.query('COMMIT');
    res.status(200).json({ message: `Withdrawal ${activityId} approved. It will be processed by the next background job run.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error approving withdrawal ${activityId}:`, err);
    res.status(500).send('Server Error');
  } finally {
    client.release();
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

router.post('/force-scan-block', async (req, res) => {
  const { blockNumber } = req.body;
  const blockNum = parseInt(blockNumber, 10);
  if (!blockNum || blockNum <= 0) {
    return res.status(400).json({ message: "A valid block number is required." });
  }

  try {
    console.log(`[ADMIN] Manual scan triggered for block #${blockNum} by admin ${req.user.id}`);
    // We import pollDeposits here to avoid circular dependency issues
    const { pollDeposits } = require('../jobs/pollDeposits');
    // We call the job, forcing it to scan only this one block
    await pollDeposits({ fromBlock: blockNum, toBlock: blockNum });
    res.status(200).json({ message: `Successfully scanned block #${blockNum}. Check logs for any new deposits found.` });
  } catch (err) {
    console.error(`Admin force-scan-block failed:`, err);
    res.status(500).json({ message: "Failed to scan block. See server logs for details." });
  }
});


// --- NEW ADMIN TOOL: Scan a specific user's wallet history ---
router.post('/scan-user-wallet', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: "A user ID is required." });
  }

  const client = await pool.connect();
  try {
    console.log(`[ADMIN] Manual wallet scan triggered for user ${userId} by admin ${req.user.id}`);
    
    const userResult = await client.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    const userWalletAddress = userResult.rows[0].eth_address;

    // Fetch all ERC20 transfers TO this user's address
    const allTransfers = await alchemy.core.getAssetTransfers({
      toAddress: userWalletAddress,
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
      // We limit the scan to a reasonable history to avoid massive queries
      fromBlock: "0x0", // You could make this more recent if needed
    });

    let newDepositsFound = 0;
    let existingDepositsFound = 0;

    // Use the same trusted logic from pollDeposits to process the results
    for (const event of allTransfers.transfers) {
      const txHash = event.hash;
      const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
      
      if (existingDeposit.rows.length === 0) {
        newDepositsFound++;
        const depositAmount_string = ethers.utils.formatUnits(event.value, tokenMap.usdc.decimals);
        console.log(`   - Found new deposit for user ${userId}: ${depositAmount_string}, tx: ${txHash}`);
        await client.query('BEGIN');
        await client.query(`INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`, [userId, depositAmount_string, txHash]);
        await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [depositAmount_string, userId]);
        await client.query('COMMIT');
      } else {
        existingDepositsFound++;
      }
    }

    const summaryMessage = `Scan complete. Found ${newDepositsFound} new deposits and ${existingDepositsFound} existing deposits for user ${userId}.`;
    console.log(`[ADMIN] ${summaryMessage}`);
    res.status(200).json({ message: summaryMessage, newDeposits: newDepositsFound, existingDeposits: existingDepositsFound });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Admin scan-user-wallet failed:`, err);
    res.status(500).json({ message: "Failed to scan wallet. See server logs for details." });
  } finally {
    if (client) client.release();
  }
});




module.exports = router;
