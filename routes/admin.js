const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');
const { sweepDepositsToTradingDesk } = require('../jobs/sweepDeposits');
const { processLedgerSweeps } = require('../jobs/processLedgerSweeps');
const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const { decrypt } = require('../utils/walletUtils'); 
const tokenMap = require('../utils/tokens/tokenMap'); 
const erc20Abi = require('../utils/abis/erc20.json'); 
const { findAndCreditDeposits } = require('../jobs/pollDeposits');

const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });

const { awardXp } = require('../utils/xpEngine');
const { calculateUserTier } = require('../utils/tierUtils');

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
      pool.query(`SELECT d.amount, u.username, u.user_id, d.detected_at FROM deposits d JOIN users u ON d.user_id = u.user_id ORDER BY d.detected_at DESC LIMIT 5;`),
      pool.query(`SELECT w.amount, u.username, w.created_at, u.user_id FROM withdrawal_queue w JOIN users u ON w.user_id = u.user_id ORDER BY w.created_at DESC LIMIT 5;`),
        pool.query(`
        SELECT log.activity_id, log.user_id, log.amount_primary, log.description, u.username, log.created_at, log.status
        FROM user_activity_log log 
        JOIN users u ON log.user_id = u.user_id 
        WHERE 
          log.activity_type = 'VAULT_WITHDRAWAL_REQUEST' 
          AND log.status NOT IN ('COMPLETED', 'FAILED')
        ORDER BY 
          log.created_at ASC;
      `)
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
router.post('/vaults/:vaultId/trades', async (req, res) => {
  const { vaultId } = req.params;
  const { 
    asset_symbol, 
    direction, 
    quantity, 
    entry_price,
    contract_address, // Now expecting this from the form
    chain = 'ETHEREUM'   // Default to ETHEREUM if not provided
  } = req.body;

  // --- Full Validation ---
  if (!asset_symbol || !direction || !quantity || !entry_price) {
    return res.status(400).json({ message: 'Missing required trade fields: symbol, direction, quantity, entry_price.' });
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return res.status(400).json({ message: 'Direction must be either LONG or SHORT.' });
  }
  if (!contract_address) {
    // We now require a contract address for Moralis to work
    return res.status(400).json({ message: 'Contract address is required for performance tracking.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO vault_trades (vault_id, asset_symbol, direction, quantity, entry_price, status, contract_address, chain)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7)
       RETURNING *`,
      [vaultId, asset_symbol.toUpperCase(), direction, quantity, entry_price, contract_address, chain.toUpperCase()]
    );
    
    res.status(201).json({ message: 'New trade successfully logged as OPEN.', trade: result.rows[0] });

  } catch (err) {
    console.error(`Error logging new trade for vault ${vaultId}:`, err);
    res.status(500).json({ message: 'Failed to log new trade.' });
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
    const [userDetails, userVaults, userActivity, bonusPoints, userPins, usernameHistory] = await Promise.all([
      // Query 1: Gets main user details (no longer selects 'tags')
      pool.query('SELECT user_id, username, email, eth_address, xp, account_tier, referral_code, created_at, balance FROM users WHERE user_id = $1', [userId]),
      // Query 2: Gets vault positions (unchanged)
      pool.query(`SELECT v.name as vault_name, vle.vault_id, SUM(vle.amount) as total_capital FROM vault_ledger_entries vle JOIN vaults v ON vle.vault_id = v.vault_id WHERE vle.user_id = $1 GROUP BY vle.vault_id, v.name HAVING SUM(vle.amount) > 0.000001`, [userId]),
      // Query 3: Gets activity log (unchanged)
      pool.query('SELECT * FROM user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
      // Query 4: Gets bonus points (unchanged)
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total FROM bonus_points WHERE user_id = $1', [userId]),
      // Query 5 (NEW): Fetches all pin names for the user from the new 'pins' table.
      pool.query("SELECT pin_name FROM pins WHERE owner_id = $1", [userId]),
      // query 6: name changes
      pool.query("SELECT old_username, new_username, changed_at FROM username_history WHERE user_id = $1 ORDER BY changed_at DESC LIMIT 10", [userId])
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
      activity: userActivity.rows,
      usernameHistory: usernameHistory.rows
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
    
    // 1. Fetch the request, including our new reliable ID
    const requestResult = await client.query(
      `SELECT user_id, amount_primary, description, related_vault_id FROM user_activity_log WHERE activity_id = $1 AND activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND status = 'PENDING'`,
      [activityId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending withdrawal request not found or already processed.' });
    }

    const request = requestResult.rows[0];
    const { user_id, related_vault_id } = request;
    const vaultId = related_vault_id;

    // --- THIS IS THE ADDED SAFETY CHECK ---
    // We confirm that a vault ID was actually found before proceeding.
    if (!vaultId) {
        throw new Error(`Could not find a related_vault_id for activity log ${activityId}.`);
    }
    // --- END OF SAFETY CHECK ---

    await client.query(
      `UPDATE vault_ledger_entries SET status = 'PENDING_PROCESS' WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'WITHDRAWAL_REQUEST' AND status = 'PENDING_APPROVAL'`,
      [user_id, vaultId]
    );
    await client.query("UPDATE user_activity_log SET status = 'APPROVED' WHERE activity_id = $1", [activityId]);
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
    
    const { scanBlockForDeposits } = require('../jobs/pollDeposits');
    
    await scanBlockForDeposits(blockNum);

    res.status(200).json({ message: `Successfully triggered scan for block #${blockNum}. Check logs for any new deposits found.` });
  } catch (err) {
    console.error(`Admin force-scan-block failed:`, err);
    res.status(500).json({ message: "Failed to scan block. See server logs for details." });
  }
});

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

    const allTransfers = await alchemy.core.getAssetTransfers({
      toAddress: userWalletAddress,
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
      fromBlock: "0x0", 
    });

    let newDepositsFound = 0;
    let existingDepositsFound = 0;

    for (const event of allTransfers.transfers) {
      const txHash = event.hash;
      const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
      
      if (existingDeposit.rows.length === 0) {
        newDepositsFound++;
        
         const depositAmount_string = event.value;
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
    if (client) await client.query('ROLLBACK').catch(console.error);
    console.error(`Admin scan-user-wallet failed:`, err);
    res.status(500).json({ message: "Failed to scan wallet. See server logs for details." });
  } finally {
    if (client) client.release();
  }
});

router.post('/bulk-award-xp', async (req, res) => {
  // Expecting a payload like: { bounties: [{ telegram_id: "user1", usd_value: 100.50 }, ...] }
  const { bounties } = req.body;
  const USD_TO_XP_RATIO = 1; // Example: 1 USD = 1 XP. We can configure this.

  if (!Array.isArray(bounties) || bounties.length === 0) {
    return res.status(400).json({ error: 'A non-empty "bounties" array is required.' });
  }

  const client = await pool.connect();
  const results = {
    success: [],
    failed: []
  };

  try {
    for (const bounty of bounties) {
      const { telegram_id, usd_value } = bounty;
      const xpToAward = parseFloat(usd_value) * USD_TO_XP_RATIO;

      // Validate each entry
      if (!telegram_id || isNaN(xpToAward) || xpToAward <= 0) {
        results.failed.push({ telegram_id, reason: 'Invalid or missing telegram_id or usd_value.' });
        continue; // Skip to the next bounty
      }

      await client.query('BEGIN');
      try {
        // Find the user by their Telegram ID
        const userResult = await client.query('SELECT user_id FROM users WHERE telegram_id = $1', [telegram_id]);
        
        if (userResult.rows.length === 0) {
          throw new Error(`User with Telegram ID '${telegram_id}' not found.`);
        }
        const userId = userResult.rows[0].user_id;

        // Create a new, UNCLAIMED XP entry in the activity log
        const description = `Awarded ${xpToAward.toFixed(2)} XP for Telegram Bounty.`;
        await client.query(
          `INSERT INTO user_activity_log (user_id, activity_type, status, source, description, amount_primary, symbol_primary)
           VALUES ($1, 'XP_BOUNTY', 'UNCLAIMED', 'TELEGRAM_BOUNTY', $2, $3, 'XP')`,
          [userId, description, xpToAward]
        );
        
        await client.query('COMMIT');
        results.success.push({ telegram_id, userId, xp_awarded: xpToAward });
        
      } catch (innerError) {
        await client.query('ROLLBACK');
        results.failed.push({ telegram_id, reason: innerError.message });
      }
    }
    
    console.log(`[Admin Bulk Award] Processed ${bounties.length} bounties. Success: ${results.success.length}, Failed: ${results.failed.length}`);
    res.status(200).json({
      message: `Processing complete. Successfully awarded ${results.success.length} bounties. Failed to award ${results.failed.length}.`,
      results: results
    });

  } catch (error) {
    // This catches errors in the main loop, though inner errors are handled above
    console.error('Major error in bulk-award-xp endpoint:', error);
    res.status(500).json({ error: 'A major server error occurred during processing.' });
  } finally {
    client.release();
  }
});

// GET all assets for a specific vault
router.get('/vaults/:vaultId/assets', async (req, res) => {
  const { vaultId } = req.params;
  try {
    const result = await pool.query(
      'SELECT asset_id, symbol, weight FROM vault_assets WHERE vault_id = $1 ORDER BY symbol',
      [vaultId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching vault assets:', err);
    res.status(500).json({ message: 'Failed to fetch vault assets.' });
  }
});

// ADD or UPDATE an asset in a vault
router.post('/vaults/:vaultId/assets', async (req, res) => {
  const { vaultId } = req.params;
  const { symbol, weight } = req.body;
  const numericWeight = parseFloat(weight);
  
  if (!symbol || isNaN(numericWeight) || numericWeight < 0 || numericWeight > 1) {
    return res.status(400).json({ message: 'Valid symbol and a weight between 0 and 1 are required.' });
  }
  
  try {
    await pool.query(
      `INSERT INTO vault_assets (vault_id, symbol, weight)
       VALUES ($1, $2, $3)
       ON CONFLICT (vault_id, symbol) DO UPDATE SET weight = EXCLUDED.weight`,
      [vaultId, symbol.toUpperCase(), numericWeight]
    );
    res.status(200).json({ message: 'Vault asset updated successfully.' });
  } catch (err) {
    console.error('Error updating vault asset:', err);
    res.status(500).json({ message: 'Failed to update vault asset.' });
  }
});

// DELETE an asset from a vault
router.delete('/vaults/:vaultId/assets/:symbol', async (req, res) => {
  const { vaultId, symbol } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM vault_assets WHERE vault_id = $1 AND symbol = $2',
      [vaultId, symbol.toUpperCase()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Asset not found for this vault.' });
    }
    res.status(200).json({ message: 'Vault asset removed successfully.' });
  } catch (err) { // <-- FIX #1: Added the missing opening curly brace '{'
    console.error('Error removing vault asset:', err);
    res.status(500).json({ message: 'Failed to remove vault asset.' });
  } 
});


// --- Vault Trade Management ---

// POST a new trade into a vault's history
router.post('/vaults/:vaultId/trades', async (req, res) => {
  const { vaultId } = req.params;
  const { 
    asset_symbol, 
    direction, 
    quantity, 
    entry_price 
  } = req.body;

  // Basic validation
  if (!asset_symbol || !direction || !quantity || !entry_price) {
    return res.status(400).json({ message: 'Missing required trade fields: symbol, direction, quantity, entry_price.' });
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return res.status(400).json({ message: 'Direction must be either LONG or SHORT.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO vault_trades (vault_id, asset_symbol, direction, quantity, entry_price, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       RETURNING *`, // Return the newly created trade for confirmation
      [vaultId, asset_symbol.toUpperCase(), direction, quantity, entry_price]
    );
    
    res.status(201).json({ message: 'New trade successfully logged as OPEN.', trade: result.rows[0] });

  } catch (err) {
    console.error(`Error logging new trade for vault ${vaultId}:`, err);
    res.status(500).json({ message: 'Failed to log new trade.' });
  }
});

// UPDATE an existing trade (e.g., to close it)
router.patch('/trades/:tradeId/close', async (req, res) => {
  const { tradeId } = req.params;
  const { exit_price } = req.body;

  if (!exit_price) {
    return res.status(400).json({ message: 'Exit price is required to close a trade.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the original trade details
    const tradeResult = await client.query('SELECT * FROM vault_trades WHERE trade_id = $1', [tradeId]);
    if (tradeResult.rows.length === 0) {
      throw new Error('Trade not found.');
    }
    const trade = tradeResult.rows[0];
    if (trade.status === 'CLOSED') {
      throw new Error('This trade has already been closed.');
    }

    // 2. Calculate the P&L
    const entryValue = parseFloat(trade.quantity) * parseFloat(trade.entry_price);
    const exitValue = parseFloat(trade.quantity) * parseFloat(exit_price);
    let pnl_usd;
    if (trade.direction === 'LONG') {
      pnl_usd = exitValue - entryValue;
    } else { // SHORT
      pnl_usd = entryValue - exitValue;
    }

    // 3. Update the trade to CLOSED with the P&L and exit details
    const updateResult = await client.query(
      `UPDATE vault_trades 
       SET exit_price = $1, pnl_usd = $2, status = 'CLOSED', trade_closed_at = NOW()
       WHERE trade_id = $3
       RETURNING *`,
      [exit_price, pnl_usd.toFixed(8), tradeId]
    );
    
    await client.query('COMMIT');
    res.status(200).json({ message: 'Trade successfully closed and P&L recorded.', trade: updateResult.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error closing trade ${tradeId}:`, err);
    res.status(500).json({ message: err.message || 'Failed to close trade.' });
  } finally {
    client.release();
  }
});

// POST to move all PENDING_SWEEP capital for a vault into the active pool
router.post('/vaults/:vaultId/allocate-capital', async (req, res) => {
  const { vaultId } = req.params;
  
  try {
    // We simply update the status of all relevant ledger entries.
    // The RETURNING clause gives us back the IDs of the rows that were changed.
    const result = await pool.query(
      `UPDATE vault_ledger_entries
       SET status = 'ACTIVE_IN_POOL'
       WHERE vault_id = $1 AND status = 'PENDING_SWEEP' AND entry_type = 'DEPOSIT'
       RETURNING entry_id`,
      [vaultId]
    );

    const updatedCount = result.rowCount;

    if (updatedCount === 0) {
      return res.status(200).json({ message: 'No pending capital to allocate for this vault.' });
    }
    
    res.status(200).json({ message: `Successfully allocated ${updatedCount} pending deposits into the active pool.` });

  } catch (err) {
    console.error(`Error allocating capital for vault ${vaultId}:`, err);
    res.status(500).json({ message: 'Failed to allocate capital.' });
  }
});

router.post('/jobs/trigger/vault-performance', async (req, res) => {
  console.log(`[ADMIN] Manual trigger of Vault Performance job by ${req.user.id}`);
  
  // We import the job here to ensure we're using the latest version
  const { updateVaultPerformance } = require('../jobs/updateVaultPerformance');
  
  // We call the job but do NOT wait for it to finish (await).
  // This lets the API respond instantly while the job runs in the background.
  updateVaultPerformance();
  
  res.status(202).json({ message: 'Vault performance update job has been triggered. Check server logs for progress.' });
});

router.get('/vaults/:vaultId/trades', async (req, res) => {
  const { vaultId } = req.params;
  try {
    const tradesResult = await pool.query(
      'SELECT * FROM vault_trades WHERE vault_id = $1 ORDER BY trade_opened_at DESC',
      [vaultId]
    );
    const allTrades = tradesResult.rows;
    res.json({
      openTrades: allTrades.filter(t => t.status === 'OPEN'),
      tradeHistory: allTrades.filter(t => t.status === 'CLOSED')
    });
  } catch (err) {
    console.error(`Error fetching trades for vault ${vaultId}:`, err);
    res.status(500).json({ message: 'Failed to fetch trades.' });
  }
});

router.get('/vaults/:vaultId/details', async (req, res) => {
    const { vaultId } = req.params;
    try {
        // We fetch the two main pieces of data in parallel
        const [vaultDetailsResult, participantsResult] = await Promise.all([
            pool.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
            pool.query(
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
                  (ut.total_capital - ut.pnl) as principal
                FROM UserTotals ut
                JOIN users u ON ut.user_id = u.user_id
                WHERE ut.total_capital > 0.000001
                ORDER BY u.username ASC`,
                [vaultId]
            )
        ]);

        if (vaultDetailsResult.rows.length === 0) {
            return res.status(404).json({ message: 'Vault not found.' });
        }
        
        const vaultDetails = vaultDetailsResult.rows[0];
        const participants = participantsResult.rows.map(p => ({
            ...p,
            total_capital: parseFloat(p.total_capital),
            principal: parseFloat(p.principal),
            pnl: parseFloat(p.pnl)
        }));

        const totalCapital = participants.reduce((sum, p) => sum + p.total_capital, 0);
        const totalPnl = participants.reduce((sum, p) => sum + p.pnl, 0);
        
        res.json({
            vault: vaultDetails,
            participants: participants,
            stats: {
                participantCount: participants.length,
                totalCapital: totalCapital,
                totalPnl: totalPnl
            }
        });

    } catch (err) {
        console.error(`Error fetching details for vault ${vaultId}:`, err);
        res.status(500).send('Server Error');
    }
});

router.get('/vaults/:vaultId/details', async (req, res) => {
    const { vaultId } = req.params;
    try {
        const [vaultDetailsResult, participantsResult] = await Promise.all([
            pool.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
            pool.query(
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
                  (ut.total_capital - ut.pnl) as principal
                FROM UserTotals ut
                JOIN users u ON ut.user_id = u.user_id
                WHERE ut.total_capital > 0.000001
                ORDER BY u.username ASC`,
                [vaultId]
            )
        ]);

        if (vaultDetailsResult.rows.length === 0) {
            return res.status(404).json({ message: 'Vault not found.' });
        }
        
        const vaultDetails = vaultDetailsResult.rows[0];
        const participants = participantsResult.rows.map(p => ({
            ...p,
            total_capital: parseFloat(p.total_capital),
            principal: parseFloat(p.principal),
            pnl: parseFloat(p.pnl)
        }));

        const totalCapital = participants.reduce((sum, p) => sum + p.total_capital, 0);
        const totalPnl = participants.reduce((sum, p) => sum + p.pnl, 0);
        
        res.json({
            vault: vaultDetails,
            participants: participants,
            stats: {
                participantCount: participants.length,
                totalCapital: totalCapital,
                totalPnl: totalPnl
            }
        });

    } catch (err) {
        console.error(`Error fetching details for vault ${vaultId}:`, err);
        res.status(500).send('Server Error');
    }
});

// --- New Withdrawal Flow Step 1: Sweep funds from Vault to User's platform wallet ---
router.post('/withdrawals/:activityId/sweep', async (req, res) => {
  const { activityId } = req.params;
  const adminUserId = req.user.id;
  
  console.log(`[Admin Sweep] Request received for activity ID ${activityId} by admin ${adminUserId}`);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the withdrawal request details, ensuring it's in the correct state
    const requestResult = await client.query(
      `SELECT user_id, amount_primary, related_vault_id 
       FROM user_activity_log 
       WHERE activity_id = $1 AND status = 'PENDING_FUNDING'`,
      [activityId]
    );

    if (requestResult.rows.length === 0) {
      throw new Error('Withdrawal request not found or not in the correct state for sweeping.');
    }
    const request = requestResult.rows[0];
    const { user_id, amount_primary, related_vault_id } = request;
    const amountToSweep = amount_primary.toString();

    // 2. Get the destination (user's platform wallet) and the source (vault's wallet)
    const [userWalletResult, vaultWalletResult] = await Promise.all([
      client.query('SELECT eth_address FROM users WHERE user_id = $1', [user_id]),
      client.query('SELECT wallet_address, wallet_private_key_encrypted FROM vaults WHERE vault_id = $1', [related_vault_id])
    ]);

    if (userWalletResult.rows.length === 0 || vaultWalletResult.rows.length === 0) {
      throw new Error('Could not find user or vault wallet information.');
    }
    const userWalletAddress = userWalletResult.rows[0].eth_address;
    const vaultWallet = vaultWalletResult.rows[0];

    if (!vaultWallet.wallet_private_key_encrypted) {
      throw new Error(`Vault ID ${related_vault_id} is missing its encrypted private key. Cannot perform sweep.`);
    }

    // 3. Perform the on-chain transaction
    const privateKey = decrypt(vaultWallet.wallet_private_key_encrypted);
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const vaultEthersWallet = new ethers.Wallet(privateKey, provider);
    
    const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, vaultEthersWallet);
    const amount_BN = ethers.utils.parseUnits(amountToSweep, tokenMap.usdc.decimals);

    console.log(`[Admin Sweep] Sweeping ${amountToSweep} USDC from Vault ${related_vault_id} (${vaultEthersWallet.address}) to User ${user_id} (${userWalletAddress})...`);
    
    const tx = await usdcContract.transfer(userWalletAddress, amount_BN);
    await tx.wait(1); // Wait for 1 block confirmation

    console.log(`[Admin Sweep] Sweep transaction successful. Hash: ${tx.hash}`);

    // 4. Update the activity log with the transaction hash and new status
    await client.query(
      "UPDATE user_activity_log SET status = 'PENDING_CONFIRMATION', related_sweep_tx_hash = $1 WHERE activity_id = $2",
      [tx.hash, activityId]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Sweep transaction successful. Awaiting final confirmation.', transactionHash: tx.hash });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Admin Sweep] FAILED for activity ID ${activityId}. Error:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to perform sweep.' });
  } finally {
    client.release();
  }
});


router.post('/withdrawals/:activityId/finalize', async (req, res) => {
  const { activityId } = req.params;
  const adminUserId = req.user.id;

  console.log(`[Admin Finalize] Request received for activity ID ${activityId} by admin ${adminUserId}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the request, ensuring it has been confirmed by our verifier job
    const requestResult = await client.query(
      `SELECT user_id, amount_primary, related_vault_id 
       FROM user_activity_log 
       WHERE activity_id = $1 AND status = 'SWEEP_CONFIRMED' FOR UPDATE`, // Lock the row
      [activityId]
    );

    if (requestResult.rows.length === 0) {
      throw new Error('Withdrawal request not found or not in the correct state for finalization.');
    }
    const request = requestResult.rows[0];
    const { user_id, amount_primary, related_vault_id } = request;
    const amountToCredit = parseFloat(amount_primary);

    // 2. Perform the internal accounting: credit the user's main balance
    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
      [amountToCredit, user_id]
    );

    // 3. Mark the entire withdrawal process as complete
    await client.query(
      "UPDATE user_activity_log SET status = 'COMPLETED' WHERE activity_id = $1",
      [activityId]
    );
    
    // --- 4. [NEW LOGIC] Handle Farming Ledger Withdrawal ---
    const vaultTypeResult = await client.query('SELECT vault_type FROM vaults WHERE vault_id = $1', [related_vault_id]);
    if (vaultTypeResult.rows[0]?.vault_type === 'FARMING') {
        // Find all protocols associated with this vault
        const protocolsInVault = await client.query("SELECT protocol_id FROM farming_protocols WHERE vault_id = $1", [related_vault_id]);
        
        for (const protocol of protocolsInVault.rows) {
            await client.query(
                `INSERT INTO farming_contribution_ledger (user_id, vault_id, protocol_id, entry_type, amount)
                 VALUES ($1, $2, $3, 'WITHDRAWAL', $4)`,
                [user_id, related_vault_id, protocol.protocol_id, amountToCredit]
            );
        }
        console.log(`[Farming] Logged withdrawal of ${amountToCredit} for user ${user_id} from ${protocolsInVault.rows.length} protocols in vault ${related_vault_id}.`);
    }
    // --- END OF NEW LOGIC ---

    await client.query('COMMIT');
    res.status(200).json({ message: `Successfully finalized withdrawal. User ${user_id} has been credited with ${amountToCredit} USDC.` });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Admin Finalize] FAILED for activity ID ${activityId}. Error:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to finalize withdrawal.' });
  } finally {
    client.release();
  }
});

router.get('/transfers/pending', async (req, res) => {
    try {
        const { rows: pendingTransfers } = await pool.query(`
            SELECT 
                t.transfer_id,
                t.user_id,
                u.username,
                t.from_vault_id,
                vf.name as from_vault_name,
                t.to_vault_id,
                vt.name as to_vault_name,
                t.amount,
                t.status,
                t.requested_at
            FROM vault_transfers t
            JOIN users u ON t.user_id = u.user_id
            JOIN vaults vf ON t.from_vault_id = vf.vault_id
            JOIN vaults vt ON t.to_vault_id = vt.vault_id
            WHERE t.status NOT IN ('COMPLETED', 'FAILED')
            ORDER BY t.requested_at ASC;
        `);
        res.status(200).json(pendingTransfers);
    } catch (error) {
        console.error('Error fetching pending transfers:', error);
        res.status(500).json({ error: 'Failed to fetch pending transfers.' });
    }
});


// --- Endpoint for an admin to process and complete a transfer ---
router.post('/transfers/:transferId/complete', async (req, res) => {
    const { transferId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Fetch the transfer request and lock the row to prevent race conditions
        const transferResult = await client.query(
            "SELECT * FROM vault_transfers WHERE transfer_id = $1 AND status = 'PENDING_UNWIND' FOR UPDATE",
            [transferId]
        );

        if (transferResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pending transfer request not found or it is not in the correct state to be processed.' });
        }
        const transfer = transferResult.rows[0];
        const { user_id, from_vault_id, to_vault_id, amount } = transfer;

        // 2. Find the corresponding 'TRANSFER_FUNDS_HELD' ledger entry
        const heldFundsResult = await client.query(
            `SELECT entry_id FROM vault_ledger_entries 
             WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'TRANSFER_FUNDS_HELD' AND amount = $3`,
            [user_id, from_vault_id, -amount]
        );

        if (heldFundsResult.rows.length === 0) {
            throw new Error(`CRITICAL: Could not find the corresponding 'TRANSFER_FUNDS_HELD' ledger entry for transfer ${transferId}. Manual intervention required.`);
        }
        const entryToUpdateId = heldFundsResult.rows[0].entry_id;

        // 3. Perform the final accounting: convert the 'HELD' entry to 'OUT' and create the 'IN' entry
        
        // a) Finalize the debit from the source vault
        await client.query(
            "UPDATE vault_ledger_entries SET entry_type = 'VAULT_TRANSFER_OUT' WHERE entry_id = $1",
            [entryToUpdateId]
        );
        
        // b) Create the credit in the destination vault
        await client.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status)
             VALUES ($1, $2, 'VAULT_TRANSFER_IN', $3, 'ACTIVE')`,
            [user_id, to_vault_id, amount]
        );
        
        // 4. Mark the transfer request as completed
        await client.query(
            "UPDATE vault_transfers SET status = 'COMPLETED', completed_at = NOW() WHERE transfer_id = $1",
            [transferId]
        );

        await client.query('COMMIT');
        
        // TODO: In the future, trigger a notification to the user that their transfer is complete.

        res.status(200).json({ message: `Transfer ${transferId} has been successfully completed.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error completing transfer ${transferId}:`, err);
        res.status(500).json({ error: 'An error occurred while completing the transfer.' });
    } finally {
        client.release();
    }
});

router.get('/reports/draft', async (req, res) => {
    const { userId, startDate, endDate } = req.query;

    if (!userId || !startDate || !endDate) {
        return res.status(400).json({ error: 'userId, startDate, and endDate (YYYY-MM-DD) are required.' });
    }

    const client = await pool.connect();
    try {
        const [
            userResult, 
            startingCapitalResult, 
            periodLedgerResult, 
            userVaultsResult, 
            monthlyPerfResult
        ] = await Promise.all([
            // 1. Fetch user details
            client.query('SELECT username FROM users WHERE user_id = $1', [userId]),
            
            // 2. Calculate starting capital FOR EACH VAULT from BEFORE the start date
            client.query(
                `SELECT vault_id, COALESCE(SUM(amount), 0) as capital 
                 FROM vault_ledger_entries 
                 WHERE user_id = $1 AND created_at < $2 
                 GROUP BY vault_id;`, 
                [userId, startDate]
            ),
            
            // 3. Fetch all ledger entries for the user WITHIN the selected date range
            client.query(
                `SELECT entry_id, vault_id, entry_type, amount, fee_amount, created_at 
                 FROM vault_ledger_entries 
                 WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 
                 ORDER BY created_at ASC;`, 
                [userId, startDate, endDate]
            ),
            
            // 4. Fetch the distinct vaults the user has ever interacted with
            client.query(
                `SELECT DISTINCT v.vault_id, v.name as vault_name, v.vault_type 
                 FROM vaults v 
                 JOIN vault_ledger_entries vle ON v.vault_id = vle.vault_id 
                 WHERE vle.user_id = $1;`, 
                [userId]
            ),
            
            // 5. Fetch the pre-logged monthly performance for all relevant vaults
            client.query(
                `SELECT vault_id, pnl_percentage FROM vault_monthly_performance WHERE month = $1;`, 
                [startDate]
            )
        ]);

        if (userResult.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'User not found.' });
        }
        
        // Process the results into easy-to-use Maps
        const startingCapitalByVault = new Map(startingCapitalResult.rows.map(r => [r.vault_id, parseFloat(r.capital)]));
        const monthlyPerfByVault = new Map(monthlyPerfResult.rows.map(r => [r.vault_id, parseFloat(r.pnl_percentage)]));

        let periodTransactions = periodLedgerResult.rows.map(t => ({
            ...t,
            amount: parseFloat(t.amount),
            fee_amount: parseFloat(t.fee_amount)
        }));

        // --- AUTO-GENERATE PNL ENTRIES ---
        for (const [vaultId, startingCapital] of startingCapitalByVault.entries()) {
            if (monthlyPerfByVault.has(vaultId) && startingCapital > 0) {
                const pnlPercentage = monthlyPerfByVault.get(vaultId);
                const pnlAmount = startingCapital * (pnlPercentage / 100.0);

                // Inject a virtual transaction into the workbench list
                periodTransactions.push({
                    entry_id: `system-pnl-${vaultId}`,
                    created_at: new Date(new Date(endDate) - 1).toISOString(), // Place it at the end of the period
                    entry_type: 'SYSTEM_CALCULATED_PNL',
                    amount: pnlAmount,
                    fee_amount: 0,
                    vault_id: vaultId
                });
            }
        }
        periodTransactions.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        // --- END OF AUTO-GENERATION ---

        const draftData = {
            userInfo: userResult.rows[0],
            userVaults: userVaultsResult.rows,
            reportStartDate: startDate,
            reportEndDate: endDate,
            startingCapital: Array.from(startingCapitalByVault.values()).reduce((sum, cap) => sum + cap, 0),
            periodTransactions // This now includes the auto-calculated PNL
        };

        res.status(200).json(draftData);

    } catch (error) {
        console.error('Error generating report draft:', error);
        res.status(500).json({ error: 'Failed to generate report draft.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// in routes/admin.js, replace the old /publish endpoint with this
router.post('/reports/:reportId/publish', async (req, res) => {
    const { reportId } = req.params;
    const { reportData, newStatus } = req.body;
    const adminUserId = req.user.id;

    if (!reportData || !newStatus || !['DRAFT', 'APPROVED'].includes(newStatus)) {
        return res.status(400).json({ error: 'reportData and a valid newStatus are required.' });
    }

    try {
        const result = await pool.query(
            `UPDATE user_monthly_reports 
             SET report_data = $1, status = $2, last_updated_by = $3 
             WHERE report_id = $4 RETURNING report_id;`,
            [reportData, newStatus, adminUserId, reportId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Report not found.' });
        }
        
        res.status(200).json({ message: `Report successfully updated to status: ${newStatus}` });

    } catch(error) {
        console.error(`Error updating report ${reportId}:`, error);
        res.status(500).json({ error: 'Failed to update report.' });
    }
});


// REPLACE the existing '/reports/generate-monthly-drafts' route in admin.js with this one.

router.post('/reports/generate-monthly-drafts', async (req, res) => {
    const adminUserId = req.user.id;
    // NOTE: pnlPercentage and notes are no longer used but we leave them in the signature
    // to avoid breaking the old DeskResultsPage immediately.
    const { vaultId, month } = req.body;

    if (!vaultId || !month) {
        return res.status(400).json({ error: 'vaultId and month (YYYY-MM-01) are required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const startDate = new Date(month);
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
        const periodEndDate = new Date(endDate - 1);

        // Find all users who had any capital in the vault during the month. This is more inclusive.
        const participantsResult = await client.query(
            `SELECT DISTINCT user_id FROM vault_ledger_entries WHERE vault_id = $1 AND created_at < $2`,
            [vaultId, endDate] // Any user with entries before the end of the month
        );
        const participants = participantsResult.rows;

        if (participants.length === 0) {
            await client.query('COMMIT');
            return res.status(200).json({ message: 'No participants found for this period to generate reports for.' });
        }

        let reportsGenerated = 0;
        // Loop through each participant and generate their individual, accurate report
        for (const participant of participants) {
            const userId = participant.user_id;

            // a) Get this user's starting capital
            const startingCapitalResult = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as capital FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND created_at < $3`,
                [userId, vaultId, startDate]
            );
            const startingCapital = parseFloat(startingCapitalResult.rows[0].capital);
            
            // Only generate a report if the user actually had capital at the start or during the month
            const allPeriodEntries = await client.query(
                `SELECT entry_type, amount FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND created_at >= $3 AND created_at < $4`,
                [userId, vaultId, startDate, endDate]
            );

            if (startingCapital <= 0 && allPeriodEntries.rows.length === 0) {
                continue; // Skip users who were not involved in this period at all
            }

            // b) Calculate totals by summing the specific ledger entries for the period
            const periodEntries = allPeriodEntries.rows.map(tx => ({ ...tx, amount: parseFloat(tx.amount) }));
            
            const pnlAmount = periodEntries.filter(tx => tx.entry_type === 'PNL_DISTRIBUTION').reduce((sum, tx) => sum + tx.amount, 0);
            const performanceFeesPaid = periodEntries.filter(tx => tx.entry_type === 'PERFORMANCE_FEE').reduce((sum, tx) => sum + tx.amount, 0);
            const periodDeposits = periodEntries.filter(tx => tx.entry_type === 'DEPOSIT' || tx.entry_type === 'VAULT_TRANSFER_IN').reduce((sum, tx) => sum + tx.amount, 0);
            const periodWithdrawals = periodEntries.filter(tx => tx.entry_type.includes('WITHDRAWAL') || tx.entry_type.includes('TRANSFER_OUT')).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

            // c) Fetch other balances
            const [buybackGainsResult, bonusPointsResult] = await Promise.all([
                 client.query(`SELECT COALESCE(SUM(amount_primary), 0) as total_gains FROM user_activity_log WHERE user_id = $1 AND activity_type = 'BONUS_POINT_BUYBACK' AND created_at >= $2 AND created_at < $3`, [userId, startDate, endDate]),
                 client.query(`SELECT COALESCE(SUM(points_amount), 0) as total_points FROM bonus_points WHERE user_id = $1 AND created_at < $2`, [userId, endDate])
            ]);
            const buybackGains = parseFloat(buybackGainsResult.rows[0].total_gains);
            const endingBonusPointsBalance = parseFloat(bonusPointsResult.rows[0].total_points);

            // d) Calculate final capital amounts
            const endingCapital = startingCapital + pnlAmount + buybackGains + performanceFeesPaid + periodDeposits - periodWithdrawals;
            const totalAccountValue = endingCapital + endingBonusPointsBalance;
            const capitalBase = startingCapital > 0 ? startingCapital : periodDeposits;
            const pnlPercentage = capitalBase > 0 ? (pnlAmount / capitalBase) * 100 : 0;

            // e) Assemble the report_data object
            const monthYearString = startDate.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            const reportData = {
                title: { key: 'reports.generated.title', vars: { monthYear: monthYearString } },
                startDate: startDate.toISOString().split('T')[0],
                endDate: periodEndDate.toISOString().split('T')[0],
                openingRemarks: { key: 'reports.generated.openingRemarks', vars: { monthYear: monthYearString } },
                closingRemarks: { key: 'reports.generated.closingRemarks' },
                summary: {
                    startingCapital, pnlAmount, pnlPercentage: parseFloat(pnlPercentage.toFixed(4)), buybackGains, performanceFeesPaid,
                    periodDeposits, periodWithdrawals, endingCapital, endingBonusPointsBalance, totalAccountValue
                }
            };

            // f) Upsert the draft report
            await client.query(
                `INSERT INTO user_monthly_reports (user_id, report_date, report_data, status, title, last_updated_by)
                 VALUES ($1, $2, $3, 'DRAFT', $4, $5)
                 ON CONFLICT (user_id, report_date) DO UPDATE SET report_data = EXCLUDED.report_data, status = 'DRAFT', last_updated_by = EXCLUDED.last_updated_by;`,
                [userId, month, reportData, reportData.title.key, adminUserId]
            );

            // g) Save the performance snapshot
            await client.query(
                `INSERT INTO user_performance_snapshots (user_id, vault_id, period_end_date, ending_account_value)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, vault_id, period_end_date) DO UPDATE SET ending_account_value = EXCLUDED.ending_account_value;`,
                [userId, vaultId, periodEndDate, endingCapital]
            );

            reportsGenerated++;
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Successfully generated ${reportsGenerated} accurate, event-driven draft reports.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error generating event-driven draft reports:', err);
        res.status(500).json({ error: 'An error occurred during draft generation.', details: err.message });
    } finally {
        client.release();
    }
});

router.get('/vault-users', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT u.user_id, u.username 
            FROM users u 
            JOIN vault_ledger_entries vle ON u.user_id = vle.user_id 
            ORDER BY u.username ASC;
        `);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching vault users:", error);
        res.status(500).json({ error: 'Failed to fetch vault users.' });
    }
});

router.get('/reports/pending-approval', async (req, res) => {
    // NEW: Read the status from a query parameter, default to PENDING_APPROVAL
    const status = req.query.status || 'PENDING_APPROVAL';

    try {
        // Fetch the full report_data so the frontend doesn't need a second API call
        const { rows } = await pool.query(`
            SELECT r.report_id, r.user_id, u.username, r.title, r.report_date, r.report_data
            FROM user_monthly_reports r
            JOIN users u ON r.user_id = u.user_id
            WHERE r.status = $1
            ORDER BY r.report_date DESC, u.username ASC;
        `, [status]);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Error fetching reports:", error);
        res.status(500).json({ error: 'Failed to fetch reports.' });
    }
});

// --- Endpoint to APPROVE or REJECT a report ---
router.post('/reports/:reportId/review', async (req, res) => {
    const { reportId } = req.params;
    const { newStatus } = req.body; // Expecting 'APPROVED' or 'DRAFT'
    const adminUserId = req.user.id;

    if (!newStatus || !['APPROVED', 'DRAFT'].includes(newStatus)) {
        return res.status(400).json({ error: "Invalid status provided. Must be 'APPROVED' or 'DRAFT'." });
    }

    try {
        const result = await pool.query(
            "UPDATE user_monthly_reports SET status = $1, last_updated_by = $2 WHERE report_id = $3 AND status = 'PENDING_APPROVAL' RETURNING report_id",
            [newStatus, adminUserId, reportId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Report not found or not in a pending state.' });
        }

        res.status(200).json({ message: `Report has been successfully set to '${newStatus}'.` });
    } catch (error) {
        console.error(`Error reviewing report ${reportId}:`, error);
        res.status(500).json({ error: 'Failed to review report.' });
    }
});

router.post('/vaults/monthly-performance', async (req, res) => {
    const adminUserId = req.user.id;
    const { vaultId, month, pnlPercentage, notes } = req.body;

    if (!vaultId || !month || pnlPercentage === undefined) {
        return res.status(400).json({ error: 'vaultId, month (YYYY-MM-01), and pnlPercentage are required.' });
    }
    const numericPnl = parseFloat(pnlPercentage);
    if (isNaN(numericPnl)) {
        return res.status(400).json({ error: 'pnlPercentage must be a valid number.' });
    }

    try {
        // Use an UPSERT to allow admins to correct a previously entered value
        const upsertQuery = `
            INSERT INTO vault_monthly_performance (vault_id, month, pnl_percentage, notes, created_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (vault_id, month)
            DO UPDATE SET
                pnl_percentage = EXCLUDED.pnl_percentage,
                notes = EXCLUDED.notes,
                created_by = EXCLUDED.created_by,
                created_at = NOW();
        `;
        
        await pool.query(upsertQuery, [vaultId, month, numericPnl, notes, adminUserId]);

        res.status(200).json({ message: `Performance for vault ${vaultId} for the month of ${month} has been successfully recorded.` });

    } catch (error) {
        console.error('Error logging monthly performance:', error);
        res.status(500).json({ error: 'Failed to log monthly performance.' });
    }
});

router.post('/vault-events', async (req, res) => {
    const adminUserId = req.user.id;
    const { vaultId, eventType, description, valueUsd, txHash } = req.body;

    if (!vaultId || !eventType || !description) {
        return res.status(400).json({ error: 'vaultId, eventType, and description are required.' });
    }

    const client = await pool.connect();
    try {
        const insertQuery = `
            INSERT INTO vault_events (vault_id, event_type, description, value_usd, related_tx_hash, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING event_id;
        `;
        
        const result = await client.query(insertQuery, [vaultId, eventType, description, valueUsd || null, txHash || null, adminUserId]);

        res.status(201).json({ 
            message: 'Vault event successfully logged.',
            eventId: result.rows[0].event_id 
        });

    } catch (error)
    {
        console.error('Error logging vault event:', error);
        res.status(500).json({ error: 'Failed to log vault event.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

router.get('/vaults/:vaultId/supporting-events', async (req, res) => {
    const { vaultId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate are required.' });
    }

    const client = await pool.connect();
    try {
        // Query 1: Fetch DEPOSITS into this vault during the period
        const depositsQuery = `
            SELECT 
                vle.entry_id AS id,
                'DEPOSIT' as type,
                vle.created_at AS event_date,
                u.username,
                (vle.amount + vle.fee_amount) as total_deposit_amount, -- The full 100%
                vle.amount as tradable_capital,
                vle.fee_amount
            FROM vault_ledger_entries vle
            JOIN users u ON vle.user_id = u.user_id
            WHERE vle.vault_id = $1 
              AND vle.entry_type = 'DEPOSIT'
              AND vle.created_at >= $2 AND vle.created_at < $3;
        `;

        // Query 2: Fetch TRADES opened during the period
        const tradesQuery = `
            SELECT 
                trade_id AS id,
                'TRADE' AS type,
                trade_opened_at AS event_date,
                asset_symbol,
                direction,
                status,
                quantity,
                entry_price,
                exit_price,
                pnl_usd
            FROM vault_trades
            WHERE vault_id = $1 AND trade_opened_at >= $2 AND trade_opened_at < $3;
        `;

        // Query 3: Fetch generic VAULT EVENTS during the period
        const eventsQuery = `
            SELECT
                event_id AS id,
                event_type AS type,
                event_date,
                description,
                value_usd
            FROM vault_events
            WHERE vault_id = $1 AND event_date >= $2 AND event_date < $3;
        `;

        const [depositsResult, tradesResult, eventsResult] = await Promise.all([
            client.query(depositsQuery, [vaultId, startDate, endDate]),
            client.query(tradesQuery, [vaultId, startDate, endDate]),
            client.query(eventsQuery, [vaultId, startDate, endDate])
        ]);

        // Combine all three sources into a single array
        const combinedEvents = [
            ...depositsResult.rows,
            ...tradesResult.rows,
            ...eventsResult.rows
        ];

        // Sort the final array chronologically
        combinedEvents.sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

        res.status(200).json(combinedEvents);

    } catch (error) {
        console.error('Error fetching supporting events:', error);
        res.status(500).json({ error: 'Failed to fetch supporting events.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// 1. ADD a new protocol to the pipeline (defaults to 'SEEDING' status)
router.post('/farming-protocols', async (req, res) => {
    const adminUserId = req.user.id;
    const { vaultId, name, chain, description, hasToken } = req.body;

    if (!vaultId || !name || !chain) {
        return res.status(400).json({ error: 'vaultId, name, and chain are required.' });
    }

    try {
        const insertQuery = `
            INSERT INTO farming_protocols (vault_id, name, chain, description, has_token)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING protocol_id;
        `;
        const result = await pool.query(insertQuery, [vaultId, name, chain, description || null, hasToken || false]);
        res.status(201).json({ 
            message: 'New protocol added to pipeline in SEEDING state.',
            protocolId: result.rows[0].protocol_id 
        });
    } catch (error) {
        console.error('Error adding new farming protocol:', error);
        res.status(500).json({ error: 'Failed to add new protocol.' });
    }
});


// 2. UPDATE the status of a protocol (e.g., move from 'SEEDING' to 'FARMING')
router.patch('/farming-protocols/:protocolId/status', async (req, res) => {
    const { protocolId } = req.params;
    const { newStatus } = req.body;

    if (!newStatus || !['SEEDING', 'FARMING', 'REAPED'].includes(newStatus)) {
        return res.status(400).json({ error: "Invalid status provided. Must be 'SEEDING', 'FARMING', or 'REAPED'." });
    }

    const client = await pool.connect(); // Use a client for transactions
    try {
        await client.query('BEGIN');

        // --- 1. Update the protocol status ---
        const protocolUpdateResult = await client.query(
            `UPDATE farming_protocols 
             SET status = $1::varchar, 
                 date_farming_started = CASE WHEN $1::varchar = 'FARMING' THEN NOW() ELSE date_farming_started END 
             WHERE protocol_id = $2 
             RETURNING protocol_id, vault_id;`,
            [newStatus, protocolId]
        );

        if (protocolUpdateResult.rowCount === 0) {
            throw new Error('Protocol not found.');
        }

        const { vault_id } = protocolUpdateResult.rows[0];

        // --- 2. [NEW LOGIC] Backfill contributions if moving to FARMING ---
        if (newStatus === 'FARMING') {
            console.log(`[Farming Backfill] Protocol ${protocolId} moved to FARMING. Backfilling contributions for vault ${vault_id}.`);

            // a) Get a list of all current investors and their total capital in this vault.
            const investorsResult = await client.query(
                `SELECT user_id, COALESCE(SUM(amount), 0) as total_capital
                 FROM vault_ledger_entries
                 WHERE vault_id = $1
                 GROUP BY user_id
                 HAVING COALESCE(SUM(amount), 0) > 0.000001;`, // Only include users with a positive balance
                [vault_id]
            );

            const investors = investorsResult.rows;
            if (investors.length > 0) {
                // b) For each existing investor, create a baseline contribution record.
                for (const investor of investors) {
                    await client.query(
                        `INSERT INTO farming_contribution_ledger (user_id, vault_id, protocol_id, entry_type, amount, created_at)
                         VALUES ($1, $2, $3, 'CONTRIBUTION', $4, NOW())`,
                        [investor.user_id, vault_id, protocolId, investor.total_capital]
                    );
                }
                console.log(`[Farming Backfill] Created baseline contributions for ${investors.length} existing investors.`);
            }
        }
        // --- END OF NEW LOGIC ---

        await client.query('COMMIT');
        res.status(200).json({ message: `Protocol status successfully updated to ${newStatus}.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error updating status for protocol ${protocolId}:`, error);
        res.status(500).json({ error: 'Failed to update protocol status.' });
    } finally {
        client.release();
    }
});



router.get('/farming-protocols', async (req, res) => {
    const { vaultId } = req.query;
    if (!vaultId) {
        return res.status(400).json({ error: 'vaultId query parameter is required.' });
    }

    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT * FROM farming_protocols WHERE vault_id = $1 ORDER BY status, created_at DESC`,
            [vaultId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error fetching farming protocols:', error);
        res.status(500).json({ error: 'Failed to fetch farming protocols.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// This endpoint is hit when an admin clicks "Complete Transfer" in the UI.
router.post('/transfers/:transferId/complete', async (req, res) => {
    const { transferId } = req.params;
    const adminUserId = req.user.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Fetch the transfer request and lock the row to prevent double-processing.
        const transferResult = await client.query(
            "SELECT * FROM vault_transfers WHERE transfer_id = $1 AND status = 'PENDING_UNWIND' FOR UPDATE",
            [transferId]
        );

        if (transferResult.rows.length === 0) {
            throw new Error('Pending transfer not found or already processed.');
        }
        const transfer = transferResult.rows[0];
        const { user_id, to_vault_id, amount } = transfer;

        // 2. Unfreeze the funds and finalize the accounting.
        //    Instead of deleting the 'HELD' record, we create a 'TRANSFER_OUT' record to balance it,
        //    creating a perfect, immutable audit trail.
        await client.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) 
             VALUES ($1, $2, 'VAULT_TRANSFER_OUT', $3, 'SWEPT')`,
            [user_id, transfer.from_vault_id, 0] // We can log a zero-amount entry just for the audit trail if needed, or adjust the logic.
                                                // A better way is to update the 'HELD' status. Let's do that.
        );

        // --- CORRECTED LOGIC ---
        // Let's update the status of the 'HELD' entry to 'PROCESSED'
        // This is cleaner than creating a zero-amount entry.
        await client.query(
            `UPDATE vault_ledger_entries 
             SET status = 'PROCESSED', entry_type = 'VAULT_TRANSFER_OUT'
             WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'TRANSFER_FUNDS_HELD' AND amount = $3`,
            [user_id, transfer.from_vault_id, -amount] // Ensure we're updating the correct entry
        );


        // 3. Credit the destination vault with the funds.
        await client.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) 
             VALUES ($1, $2, 'VAULT_TRANSFER_IN', $3, 'SWEPT')`,
            [user_id, to_vault_id, amount]
        );

        // 4. Update the main transfer request record to mark it as complete.
        await client.query(
            "UPDATE vault_transfers SET status = 'COMPLETED', completed_at = NOW() WHERE transfer_id = $1",
            [transferId]
        );

        // 5. Update the user activity log.
        // We find the original request and update its status.
        const description = `Requested transfer of ${parseFloat(amount).toFixed(2)} USDC from Vault ${transfer.from_vault_id} to Vault ${transfer.to_vault_id}.`;
        await client.query(
            "UPDATE user_activity_log SET status = 'COMPLETED' WHERE user_id = $1 AND activity_type = 'VAULT_TRANSFER_REQUEST' AND description = $2 AND status = 'PENDING'",
            [user_id, description]
        );

        // --- START FARMING LEDGER INTEGRATION (FROM PREVIOUS DISCUSSION) ---
        // Now, we apply the farming logic right here, at the moment the funds are settled.
        
        // a) Handle withdrawal from any source farming protocols
        const fromVaultTypeResult = await client.query('SELECT vault_type FROM vaults WHERE vault_id = $1', [transfer.from_vault_id]);
        if (fromVaultTypeResult.rows[0]?.vault_type === 'FARMING') {
            const protocolsInSourceVault = await client.query("SELECT protocol_id FROM farming_protocols WHERE vault_id = $1", [transfer.from_vault_id]);
            for (const protocol of protocolsInSourceVault.rows) {
                await client.query(
                    `INSERT INTO farming_contribution_ledger (user_id, vault_id, protocol_id, entry_type, amount)
                     VALUES ($1, $2, $3, 'WITHDRAWAL', $4)`,
                    [user_id, transfer.from_vault_id, protocol.protocol_id, amount]
                );
            }
        }

        // b) Handle contribution to any destination farming protocols
        const toVaultTypeResult = await client.query('SELECT vault_type FROM vaults WHERE vault_id = $1', [transfer.to_vault_id]);
        if (toVaultTypeResult.rows[0]?.vault_type === 'FARMING') {
            const activeProtocolsInDestVault = await client.query("SELECT protocol_id FROM farming_protocols WHERE vault_id = $1 AND status = 'FARMING'", [transfer.to_vault_id]);
            for (const protocol of activeProtocolsInDestVault.rows) {
                await client.query(
                    `INSERT INTO farming_contribution_ledger (user_id, vault_id, protocol_id, entry_type, amount)
                     VALUES ($1, $2, $3, 'CONTRIBUTION', $4)`,
                    [user_id, to_vault_id, protocol.protocol_id, amount]
                );
            }
        }
        // --- END FARMING LEDGER INTEGRATION ---

        await client.query('COMMIT');

        res.status(200).json({ message: 'Transfer successfully completed and credited to the user.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error completing transfer ${transferId} by admin ${adminUserId}:`, err);
        res.status(500).json({ error: 'Failed to complete transfer.' });
    } finally {
        client.release();
    }
});


router.get('/users/:userId/xp-audit', async (req, res) => {
    const { userId } = req.params;
    const client = await pool.connect();

    try {
        // --- 1. Fetch the user's current XP total from the users table ---
        const userXpResult = await client.query('SELECT xp FROM users WHERE user_id = $1', [userId]);
        
        if (userXpResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const expectedTotal = parseFloat(userXpResult.rows[0].xp);

        // --- 2. Fetch all historical XP transactions from the activity log ---
        const xpHistoryQuery = `
            SELECT 
                activity_id, 
                created_at, 
                description,
                amount_primary as xp_amount,
                source,
                status
            FROM 
                user_activity_log 
            WHERE 
                user_id = $1 
                AND (
                    activity_type LIKE 'XP_%' 
                    OR source = 'SIGNUP_BONUS'
                    OR activity_type IN ('DEPOSIT_BONUS', 'REFERRAL_BONUS', 'SIGNUP_BONUS', 'PLATFORM_REWARD')
                )
            ORDER BY 
                created_at DESC;
        `;
        const xpHistoryResult = await client.query(xpHistoryQuery, [userId]);
        const history = xpHistoryResult.rows;

        // --- 3. Calculate the total from the log, respecting the status ---
        // We only sum entries that have been 'CLAIMED' or 'COMPLETED'. 'UNCLAIMED' XP doesn't count toward the user's total yet.
        const calculatedTotal = history
            .filter(log => log.status === 'CLAIMED' || log.status === 'COMPLETED')
            .reduce((sum, log) => sum + parseFloat(log.xp_amount), 0);

        // --- 4. Assemble the final report ---
        const auditReport = {
            userId: userId,
            expectedTotal: expectedTotal,
            calculatedTotal: parseFloat(calculatedTotal.toFixed(8)), // Round to match DB precision
            discrepancy: parseFloat((expectedTotal - calculatedTotal).toFixed(8)),
            history: history.map(log => ({
                ...log,
                xp_amount: parseFloat(log.xp_amount)
            }))
        };
        
        res.status(200).json(auditReport);

    } catch (err) {
        console.error(`Error performing XP audit for user ${userId}:`, err);
        res.status(500).json({ error: 'An error occurred during the XP audit.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// Add this new endpoint to routes/admin.js

router.post('/rewards/distribute-by-xp', async (req, res) => {
    const adminUserId = req.user.id;
    const { totalRewardUsd, participatingVaultIds, description } = req.body;

    // --- 1. Validation ---
    const numericReward = parseFloat(totalRewardUsd);
    if (isNaN(numericReward) || numericReward <= 0) {
        return res.status(400).json({ error: 'A valid, positive totalRewardUsd is required.' });
    }
    if (!Array.isArray(participatingVaultIds) || participatingVaultIds.length === 0) {
        return res.status(400).json({ error: 'participatingVaultIds must be a non-empty array.' });
    }
    if (!description || description.trim() === '') {
        return res.status(400).json({ error: 'A clear description for the activity log is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log(`[XP Reward] Starting distribution of ${numericReward} USD for vaults: [${participatingVaultIds.join(', ')}]`);

        // --- 2. Get a unique list of all users invested in the participating vaults ---
        const eligibleUsersQuery = `
            SELECT DISTINCT user_id
            FROM vault_ledger_entries
            WHERE vault_id = ANY($1::int[])
            GROUP BY user_id
            HAVING SUM(amount) > 0.000001;
        `;
        const eligibleUsersResult = await client.query(eligibleUsersQuery, [participatingVaultIds]);
        const userIds = eligibleUsersResult.rows.map(r => r.user_id);

        if (userIds.length === 0) {
            await client.query('ROLLBACK'); // No need to proceed if no one is eligible
            return res.status(200).json({ message: 'Distribution aborted. No eligible users found in the specified vaults.' });
        }
        
        console.log(`[XP Reward] Found ${userIds.length} eligible participants.`);

        // --- 3. Fetch the XP scores for these eligible users ---
        const userXpQuery = `SELECT user_id, xp FROM users WHERE user_id = ANY($1::uuid[])`;
        const userXpResult = await client.query(userXpQuery, [userIds]);

        let totalEligibleXp = 0;
        const userXpMap = new Map();
        for (const user of userXpResult.rows) {
            const xp = parseFloat(user.xp);
            if (xp > 0) {
                totalEligibleXp += xp;
                userXpMap.set(user.user_id, xp);
            }
        }

        if (totalEligibleXp <= 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'Distribution aborted. Total XP of eligible users is zero.' });
        }
        
        console.log(`[XP Reward] Total eligible XP for distribution: ${totalEligibleXp}.`);

        // --- 4. For each eligible user, calculate their share and distribute it proportionally across their holdings ---
        for (const [userId, userXp] of userXpMap.entries()) {
            const userShare = userXp / totalEligibleXp;
            const userTotalPnl = numericReward * userShare;

            // Find which of the participating vaults this user is invested in and their capital in each
            const userHoldingsResult = await client.query(
                `SELECT vault_id, SUM(amount) as capital
                 FROM vault_ledger_entries
                 WHERE user_id = $1 AND vault_id = ANY($2::int[])
                 GROUP BY vault_id
                 HAVING SUM(amount) > 0;`,
                [userId, participatingVaultIds]
            );

            const userHoldings = userHoldingsResult.rows;
            const totalUserCapitalInVaults = userHoldings.reduce((sum, holding) => sum + parseFloat(holding.capital), 0);

            if (totalUserCapitalInVaults > 0) {
                // Distribute the PNL proportionally to their capital in each eligible vault
                for (const holding of userHoldings) {
                    const vaultId = holding.vault_id;
                    const capitalInVault = parseFloat(holding.capital);
                    const proportion = capitalInVault / totalUserCapitalInVaults;
                    const pnlForThisVault = userTotalPnl * proportion;

                    if (pnlForThisVault > 0.000001) {
                        // Insert the PNL into the main ledger
                        await client.query(
                            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status)
                             VALUES ($1, $2, 'PNL_DISTRIBUTION', $3, 'SWEPT');`,
                            [userId, vaultId, pnlForThisVault]
                        );
                    }
                }
            }
            
            // Create a single, clear activity log entry for the user for the total PNL they received
            const activityLogDesc = `Received ${userTotalPnl.toFixed(2)} USDC as a platform reward from ${description}.`;
            await client.query(
                `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status, source)
                 VALUES ($1, 'PLATFORM_REWARD', $2, $3, 'USDC', 'COMPLETED', 'XP_WEIGHTED_DISTRO');`,
                [userId, activityLogDesc, userTotalPnl]
            );
        }

        console.log(`[XP Reward] Successfully calculated and logged PNL for ${userXpMap.size} users.`);

        await client.query('COMMIT');
        res.status(200).json({ message: `Successfully distributed ${numericReward} USD to ${userXpMap.size} users based on XP.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('XP-weighted reward distribution failed:', err);
        res.status(500).json({ error: 'An error occurred during reward distribution.' });
    } finally {
        client.release();
    }
});

router.get('/vaults/all', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT vault_id, name, vault_type, status FROM vaults ORDER BY vault_id ASC');
        res.status(200).json(rows);
    } catch (error) {
        console.error("Error fetching all vaults for admin:", error);
        res.status(500).json({ error: 'Failed to fetch vault list.' });
    }
});

// in routes/admin.js

router.post('/farming-protocols/:protocolId/reap', async (req, res) => {
    const { protocolId } = req.params;
    const { realizedUsdValue } = req.body;
    const adminUserId = req.user.id;
    
    const numericValue = parseFloat(realizedUsdValue);
    if (isNaN(numericValue) || numericValue <= 0) {
        return res.status(400).json({ error: 'A valid, positive realizedUsdValue is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- Step 1: Fetch protocol info and lock the row ---
        const protocolResult = await client.query(
            "SELECT vault_id, name FROM farming_protocols WHERE protocol_id = $1 AND status = 'FARMING' FOR UPDATE", 
            [protocolId]
        );
        if (protocolResult.rows.length === 0) {
            throw new Error('Farming protocol not found or not in FARMING status.');
        }
        const { vault_id, name: protocolName } = protocolResult.rows[0];
        const reapDate = new Date();

        // --- Step 2: Update the protocol to record the harvest ---
        // We still record the realized value against the protocol for historical tracking.
        await client.query(
            `UPDATE farming_protocols 
             SET has_rewards = TRUE, rewards_realized_usd = COALESCE(rewards_realized_usd, 0) + $1, date_reaped = $2 
             WHERE protocol_id = $3;`,
            [numericValue, reapDate, protocolId]
        );
        
        // --- Step 3 (NEW LOGIC): Add the reaped funds to the Buyback Pool Ledger ---
        const buybackLedgerName = 'FARMING_BUYBACK_POOL';
        await client.query(
            `UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = $2`,
            [numericValue, buybackLedgerName]
        );
        
        // --- Step 4 (NEW LOGIC): Create a treasury transaction for a clear audit trail ---
        const description = `Reaped $${numericValue.toFixed(2)} from farming protocol '${protocolName}' (ID: ${protocolId}). Funds added to buyback pool.`;
        await client.query(
            `INSERT INTO treasury_transactions (to_ledger_id, amount, description) 
             VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = $1), $2, $3)`,
            [buybackLedgerName, numericValue, description]
        );
        
        await client.query('COMMIT');
        res.status(200).json({ message: `Successfully reaped $${numericValue} from ${protocolName}. Funds have been added to the buyback pool.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error reaping rewards for protocol ${protocolId}:`, error);
        res.status(500).json({ error: error.message || 'Failed to reap rewards.' });
    } finally {
        client.release();
    }
});

router.get('/reports/draft-count', async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT COUNT(*) FROM user_monthly_reports WHERE status = 'DRAFT'");
        const count = parseInt(rows[0].count, 10);
        res.json({ draftCount: count });
    } catch (error) {
        console.error("Error fetching draft report count:", error);
        res.status(500).json({ error: 'Failed to fetch count.' });
    }
});

router.delete('/reports', async (req, res) => {
    // We now expect an array of IDs in the request body, e.g., { reportIds: [...] }
    const { reportIds } = req.body;
    const adminUserId = req.user.id;

    if (!Array.isArray(reportIds) || reportIds.length === 0) {
        return res.status(400).json({ error: 'An array of reportIds is required.' });
    }

    console.log(`[ADMIN] Request to delete ${reportIds.length} reports by admin ${adminUserId}.`);

    try {
        // The ANY() function with an array parameter is the most efficient way to delete multiple rows.
        const deleteResult = await pool.query(
            'DELETE FROM user_monthly_reports WHERE report_id = ANY($1::uuid[])',
            [reportIds]
        );

        if (deleteResult.rowCount === 0) {
            return res.status(404).json({ error: 'None of the specified reports were found.' });
        }

        res.status(200).json({ message: `Successfully deleted ${deleteResult.rowCount} reports.` });

    } catch (error) {
        console.error('Error during batch delete of reports:', error);
        res.status(500).json({ error: 'An internal server error occurred while deleting reports.' });
    }
});

router.get('/users/:userId/reports', async (req, res) => {
    const { userId: targetUserId } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT report_id, title, report_date, status, created_at
             FROM user_monthly_reports
             WHERE user_id = $1
             ORDER BY report_date DESC`,
            [targetUserId]
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error(`Error fetching reports for user ${targetUserId}:`, error);
        res.status(500).json({ error: 'Failed to fetch user reports.' });
    }
});

// Add this new route to routes/admin.js

router.get('/reports/aggregate', async (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate query parameters (YYYY-MM-DD) are required.' });
    }

    const client = await pool.connect();
    try {
        const [
            depositStats,
            withdrawalStats,
            feeStats,
            buybackStats,
            pnlStats
        ] = await Promise.all([
            // 1. Total capital deposited
            client.query(
                `SELECT COALESCE(SUM(amount), 0) as total_deposited, COUNT(*) as deposit_count
                 FROM deposits
                 WHERE detected_at >= $1 AND detected_at < $2`,
                [startDate, endDate]
            ),
            // 2. Total capital withdrawn --- THIS QUERY IS NOW FIXED ---
            client.query(
                `SELECT COALESCE(SUM(amount), 0) as total_withdrawn, COUNT(*) as withdrawal_count
                 FROM withdrawals
                 WHERE created_at >= $1 AND created_at < $2`, // The column is 'created_at'
                [startDate, endDate]
            ),
            // 3. Total fees collected
            client.query(
                `SELECT
                    COALESCE(SUM(CASE WHEN entry_type = 'DEPOSIT' THEN fee_amount ELSE 0 END), 0) as deposit_fees,
                    COALESCE(SUM(CASE WHEN entry_type = 'PERFORMANCE_FEE' THEN amount ELSE 0 END), 0) as performance_fees
                 FROM vault_ledger_entries
                 WHERE created_at >= $1 AND created_at < $2`,
                [startDate, endDate]
            ),
            // 4. Total buybacks paid out
            client.query(
                `SELECT COALESCE(SUM(amount_primary), 0) as total_buybacks
                 FROM user_activity_log
                 WHERE activity_type = 'BONUS_POINT_BUYBACK' AND created_at >= $1 AND created_at < $2`,
                [startDate, endDate]
            ),
            // 5. Total PNL distributed
            client.query(
                `SELECT COALESCE(SUM(amount), 0) as total_pnl
                 FROM vault_ledger_entries
                 WHERE entry_type = 'PNL_DISTRIBUTION' AND created_at >= $1 AND created_at < $2`,
                [startDate, endDate]
            )
        ]);

        const depositData = depositStats.rows[0];
        const withdrawalData = withdrawalStats.rows[0];
        const feeData = feeStats.rows[0];
        const buybackData = buybackStats.rows[0];
        const pnlData = pnlStats.rows[0];
        
        const totalFees = parseFloat(feeData.deposit_fees) + Math.abs(parseFloat(feeData.performance_fees));
        const totalPnl = parseFloat(pnlData.total_pnl);
        const totalDeposits = parseFloat(depositData.total_deposited);
        const totalWithdrawals = parseFloat(withdrawalData.total_withdrawn);
        const netFlow = totalDeposits - totalWithdrawals;

        // Assemble the final report object
        const aggregateReport = {
            period: {
                startDate,
                endDate
            },
            capitalFlow: {
                totalDeposits,
                depositCount: parseInt(depositData.deposit_count, 10),
                totalWithdrawals,
                withdrawalCount: parseInt(withdrawalData.withdrawal_count, 10),
                netFlow
            },
            revenueAndDistribution: {
                totalPnlDistributed: totalPnl,
                totalBuybacksPaid: parseFloat(buybackData.total_buybacks),
                fees: {
                    depositFees: parseFloat(feeData.deposit_fees),
                    performanceFees: Math.abs(parseFloat(feeData.performance_fees)), // Stored as negative, display as positive
                    totalFees
                },
                platformNet: totalFees - parseFloat(buybackData.total_buybacks) // A simple metric of fees vs. payouts
            }
        };

        res.status(200).json(aggregateReport);

    } catch (error) {
        console.error('Error generating aggregate report:', error);
        res.status(500).json({ error: 'Failed to generate aggregate report.' });
    } finally {
        client.release();
    }
});

// Add this new route to routes/admin.js

// REPLACE the existing '/calculate-and-post-fees' route in admin.js with this one.

// REPLACE the existing '/calculate-and-post-fees' route in admin.js with this one.

router.post('/calculate-and-post-fees', async (req, res) => {
    // NOTE: We no longer use pnlPercentage. It is ignored.
    const { vaultId, month } = req.body;
    const adminUserId = req.user.id;

    if (!vaultId || !month) {
        return res.status(400).json({ error: 'vaultId and month (YYYY-MM-01) are required.' });
    }
    const PERFORMANCE_FEE_RATE = 0.20; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const startDate = new Date(month);
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
        const feeTimestamp = new Date(endDate - 1000);

        const participantsResult = await client.query(
            `SELECT DISTINCT user_id FROM vault_ledger_entries WHERE vault_id = $1 AND created_at < $2`,
            [vaultId, endDate]
        );
        const participants = participantsResult.rows;

        if (participants.length === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'No participants found for this period. No fees calculated.' });
        }

        let feesPostedCount = 0;
        let totalFeesCalculated = 0;
        const results = [];

        for (const participant of participants) {
            const userId = participant.user_id;

            // --- THIS IS THE FIX: We get the TRUE PNL from the ledger ---
            const [startingCapitalResult, truePnlResult] = await Promise.all([
                client.query(`SELECT COALESCE(SUM(amount), 0) as capital FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND created_at < $3`, [userId, vaultId, startDate]),
                client.query(`SELECT COALESCE(SUM(amount), 0) as pnl FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'PNL_DISTRIBUTION' AND created_at >= $3 AND created_at < $4`, [userId, vaultId, startDate, endDate])
            ]);
            const startingCapital = parseFloat(startingCapitalResult.rows[0].capital);
            const grossPnl = parseFloat(truePnlResult.rows[0].pnl);
            // --- END OF FIX ---

            // Skip users who weren't active in this period
            if (startingCapital <= 0 && grossPnl === 0 && (await client.query('SELECT 1 FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND created_at >= $3 AND created_at < $4 LIMIT 1', [userId, vaultId, startDate, endDate])).rows.length === 0) {
                continue;
            }

            const hwmResult = await client.query(`SELECT COALESCE(MAX(ending_account_value), 0) as high_water_mark FROM user_performance_snapshots WHERE user_id = $1 AND vault_id = $2 AND period_end_date < $3`, [userId, vaultId, startDate]);
            const highWaterMark = parseFloat(hwmResult.rows[0].high_water_mark);

            const newAccountValue = startingCapital + grossPnl;
            let feeAmount = 0;
            
            if (newAccountValue > highWaterMark && grossPnl > 0) {
                const profitSubjectToFee = Math.min(grossPnl, newAccountValue - highWaterMark);
                feeAmount = profitSubjectToFee * PERFORMANCE_FEE_RATE;

                if (feeAmount > 0.000001) {
                    await client.query(
                        `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status, created_at)
                         VALUES ($1, $2, 'PERFORMANCE_FEE', $3, 'SWEPT', $4);`,
                        [userId, vaultId, -feeAmount, feeTimestamp]
                    );
                    feesPostedCount++;
                    totalFeesCalculated += feeAmount;
                }
            }

            results.push({
                userId, username: (await client.query('SELECT username FROM users WHERE user_id = $1', [userId])).rows[0].username,
                startingCapital, highWaterMark, grossPnl, newAccountValue, feeAmount
            });
        }

        await client.query('COMMIT');
        res.status(200).json({ 
            message: `Fee calculation complete using event-driven PNL. Posted ${feesPostedCount} fee transactions totaling $${totalFeesCalculated.toFixed(2)}.`,
            calculationResults: results
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error in calculate-and-post-fees endpoint:', err);
        res.status(500).json({ error: 'An error occurred during fee calculation.' });
    } finally {
        client.release();
    }
});

router.get('/monthly-audit-data', async (req, res) => {
    const { vaultId, month } = req.query;

    if (!vaultId || !month) {
        return res.status(400).json({ error: 'vaultId and month (YYYY-MM-01) query parameters are required.' });
    }
    
    const client = await pool.connect();
    try {
        const startDate = new Date(month);
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);

        const [officialPerf, ledgerPerf, reportedPerf] = await Promise.all([
            // 1. Get the official performance percentage entered by the admin
            client.query(
                `SELECT pnl_percentage FROM vault_monthly_performance WHERE vault_id = $1 AND month = $2`,
                [vaultId, month]
            ),
            // 2. Sum all PNL distribution entries from the vault ledger for the period
            client.query(
                `SELECT COALESCE(SUM(amount), 0) as total_pnl
                 FROM vault_ledger_entries
                 WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION' AND created_at >= $2 AND created_at < $3`,
                [vaultId, startDate, endDate]
            ),
            // 3. Sum the 'pnlAmount' from the JSON data of all generated reports for the period
            client.query(
                `SELECT COALESCE(SUM((report_data->'summary'->>'pnlAmount')::numeric), 0) as total_pnl
                 FROM user_monthly_reports
                 WHERE report_date = $1 AND (report_data->'summary'->>'pnlAmount') IS NOT NULL`, // Checks if the key exists before summing
                [month]
            )
        ]);

        const auditData = {
            period: {
                vaultId,
                month
            },
            officialSystemPnlPercentage: officialPerf.rows.length > 0 ? parseFloat(officialPerf.rows[0].pnl_percentage) : null,
            totalPnlInLedger: parseFloat(ledgerPerf.rows[0].total_pnl),
            totalPnlInGeneratedReports: parseFloat(reportedPerf.rows[0].total_pnl)
        };
        
        res.status(200).json(auditData);

    } catch (error) {
        console.error('Error fetching monthly audit data:', error);
        res.status(500).json({ error: 'Failed to fetch audit data.' });
    } finally {
        client.release();
    }
});

router.get('/pnl-events', async (req, res) => {
    const { vaultId, month } = req.query;

    if (!vaultId || !month) {
        return res.status(400).json({ error: 'vaultId and month (YYYY-MM-01) query parameters are required.' });
    }

    try {
        const startDate = new Date(month);
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);

        const { rows } = await pool.query(
            `SELECT
                vle.entry_id,
                vle.user_id,
                u.username,
                vle.amount,
                vle.created_at
             FROM vault_ledger_entries vle
             JOIN users u ON vle.user_id = u.user_id
             WHERE
                vle.vault_id = $1
                AND vle.entry_type = 'PNL_DISTRIBUTION'
                AND vle.created_at >= $2
                AND vle.created_at < $3
             ORDER BY vle.created_at DESC`,
            [vaultId, startDate, endDate]
        );

        // Format the data for the frontend
        const pnlEvents = rows.map(row => ({
            ...row,
            amount: parseFloat(row.amount)
        }));
        
        res.status(200).json(pnlEvents);

    } catch (error) {
        console.error('Error fetching PNL events:', error);
        res.status(500).json({ error: 'Failed to fetch PNL events.' });
    }
});

router.post('/pnl-events', async (req, res) => {
    const { vaultId, userId, amount, eventDate } = req.body;

    // --- Validation ---
    const numericAmount = parseFloat(amount);
    if (!vaultId || !userId || !eventDate || isNaN(numericAmount)) {
        return res.status(400).json({ error: 'vaultId, userId, a valid eventDate, and a numeric amount are required.' });
    }
    if (new Date(eventDate).toString() === 'Invalid Date') {
        return res.status(400).json({ error: 'The provided eventDate is not a valid date string.' });
    }

    try {
        const insertQuery = `
            INSERT INTO vault_ledger_entries
                (user_id, vault_id, entry_type, amount, status, created_at)
            VALUES
                ($1, $2, 'PNL_DISTRIBUTION', $3, 'SWEPT', $4)
            RETURNING entry_id, user_id, vault_id, entry_type, amount, created_at;
        `;

        const { rows } = await pool.query(insertQuery, [userId, vaultId, numericAmount, eventDate]);
        
        const newPnlEvent = {
            ...rows[0],
            amount: parseFloat(rows[0].amount)
        };
        
        res.status(201).json({ message: 'PNL event successfully added.', newEvent: newPnlEvent });

    } catch (error) {
        console.error('Error adding PNL event:', error);
        res.status(500).json({ error: 'Failed to add PNL event.' });
    }
});

router.post('/pnl-events', async (req, res) => {
    const { vaultId, userId, amount, eventDate } = req.body;

    // --- Validation ---
    const numericAmount = parseFloat(amount);
    if (!vaultId || !userId || !eventDate || isNaN(numericAmount)) {
        return res.status(400).json({ error: 'vaultId, userId, a valid eventDate, and a numeric amount are required.' });
    }
    if (new Date(eventDate).toString() === 'Invalid Date') {
        return res.status(400).json({ error: 'The provided eventDate is not a valid date string.' });
    }

    try {
        const insertQuery = `
            INSERT INTO vault_ledger_entries
                (user_id, vault_id, entry_type, amount, status, created_at)
            VALUES
                ($1, $2, 'PNL_DISTRIBUTION', $3, 'SWEPT', $4)
            RETURNING entry_id, user_id, vault_id, entry_type, amount, created_at;
        `;

        const { rows } = await pool.query(insertQuery, [userId, vaultId, numericAmount, eventDate]);
        
        const newPnlEvent = {
            ...rows[0],
            amount: parseFloat(rows[0].amount)
        };
        
        res.status(201).json({ message: 'PNL event successfully added.', newEvent: newPnlEvent });

    } catch (error) {
        console.error('Error adding PNL event:', error);
        res.status(500).json({ error: 'Failed to add PNL event.' });
    }
});

router.delete('/pnl-events/:entryId', async (req, res) => {
    const { entryId } = req.params;

    try {
        const deleteQuery = `
            DELETE FROM vault_ledger_entries
            WHERE entry_id = $1 AND entry_type = 'PNL_DISTRIBUTION';
        `;
        
        const result = await pool.query(deleteQuery, [entryId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'PNL event not found or it has already been deleted.' });
        }

        res.status(200).json({ message: `PNL event ${entryId} has been successfully deleted.` });
    } catch (error) {
        console.error(`Error deleting PNL event ${entryId}:`, error);
        res.status(500).json({ error: 'Failed to delete PNL event.' });
    }
});

// Add this new route to routes/admin.js

router.post('/rewards/preview-hybrid-distribution', async (req, res) => {
    const { totalRewardUsd, participatingVaultIds } = req.body;

    const numericReward = parseFloat(totalRewardUsd);
    if (isNaN(numericReward) || numericReward <= 0 || !Array.isArray(participatingVaultIds) || participatingVaultIds.length === 0) {
        return res.status(400).json({ error: 'A valid totalRewardUsd and a non-empty array of participatingVaultIds are required.' });
    }

    const client = await pool.connect();
    try {
        const eligibleUsersResult = await client.query(
            `SELECT DISTINCT u.user_id, u.username, u.xp
             FROM users u
             JOIN vault_ledger_entries vle ON u.user_id = vle.user_id
             WHERE vle.vault_id = ANY($1::int[])`,
            [participatingVaultIds]
        );
        const eligibleUsers = eligibleUsersResult.rows;
        const userIds = eligibleUsers.map(u => u.user_id);

        if (userIds.length === 0) {
            return res.json({ message: 'No eligible users found in the specified vaults.', preview: [] });
        }

        const [bonusPointsResult, totalXpResult] = await Promise.all([
            client.query(
                `SELECT user_id, COALESCE(SUM(points_amount), 0) as total_points
                 FROM bonus_points
                 WHERE user_id = ANY($1::uuid[])
                 GROUP BY user_id`,
                [userIds]
            ),
            client.query(
                `SELECT COALESCE(SUM(xp), 0) as total_xp FROM users WHERE user_id = ANY($1::uuid[])`,
                [userIds]
            )
        ]);
        
        const bonusPointsMap = new Map(bonusPointsResult.rows.map(r => [r.user_id, parseFloat(r.total_points)]));
        const totalEligibleXp = parseFloat(totalXpResult.rows[0].total_xp);
        let totalOutstandingBonusPoints = Array.from(bonusPointsMap.values()).reduce((sum, points) => sum + points, 0);

        let remainingRewardPool = numericReward;
        const previewResults = [];

        let amountForBuyback = Math.min(remainingRewardPool, totalOutstandingBonusPoints);
        if (amountForBuyback > 0) {
            remainingRewardPool -= amountForBuyback;
        }

        let amountForXp = remainingRewardPool;

        for (const user of eligibleUsers) {
            let userBuybackAmount = 0;
            if (amountForBuyback > 0 && totalOutstandingBonusPoints > 0) {
                const userBonusPoints = bonusPointsMap.get(user.user_id) || 0;
                userBuybackAmount = (userBonusPoints / totalOutstandingBonusPoints) * amountForBuyback;
            }

            let userXpAmount = 0;
            if (amountForXp > 0 && totalEligibleXp > 0) {
                const userXp = parseFloat(user.xp) || 0;
                userXpAmount = (userXp / totalEligibleXp) * amountForXp;
            }

            previewResults.push({
                userId: user.user_id,
                username: user.username,
                bonusPointPayout: userBuybackAmount,
                xpBasedPayout: userXpAmount,
                totalPayout: userBuybackAmount + userXpAmount
            });
        }
        
        previewResults.sort((a, b) => b.totalPayout - a.totalPayout);

        res.status(200).json({
            summary: {
                totalRewardPool: numericReward,
                allocatedToBuyback: amountForBuyback,
                allocatedToXp: amountForXp,
                participantCount: eligibleUsers.length
            },
            preview: previewResults
        });

    } catch (error) {
        console.error('Error previewing hybrid distribution:', error);
        res.status(500).json({ error: 'Failed to generate distribution preview.' });
    } finally {
        client.release();
    }
});

// In routes/admin.js, replace the entire 'execute-hybrid-distribution' function.
// Make sure the necessary 'require' statements for 'awardXp' are at the top of the file.

router.post('/rewards/execute-hybrid-distribution', async (req, res) => {
    const { totalRewardUsd, participatingVaultIds, description } = req.body;
    const adminUserId = req.user.id;
    const numericReward = parseFloat(totalRewardUsd);

    if (isNaN(numericReward) || numericReward <= 0 || !Array.isArray(participatingVaultIds) || participatingVaultIds.length === 0 || !description) {
        return res.status(400).json({ error: 'A valid totalRewardUsd, a non-empty array of participatingVaultIds, and a description are required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const poolBalanceResult = await client.query("SELECT balance FROM treasury_ledgers WHERE ledger_name = 'FARMING_BUYBACK_POOL' FOR UPDATE");
        const poolBalance = parseFloat(poolBalanceResult.rows[0]?.balance || 0);

        if (poolBalance < numericReward) {
            throw new Error(`Insufficient funds in FARMING_BUYBACK_POOL. Available: $${poolBalance.toFixed(2)}, Requested: $${numericReward.toFixed(2)}`);
        }

        // ... (User and XP calculation logic remains the same)
        const eligibleUsersResult = await client.query(`SELECT DISTINCT u.user_id, u.username, u.xp FROM users u JOIN vault_ledger_entries vle ON u.user_id = vle.user_id WHERE vle.vault_id = ANY($1::int[])`, [participatingVaultIds]);
        const eligibleUsers = eligibleUsersResult.rows;
        if (eligibleUsers.length === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'No eligible users found. No funds distributed.' });
        }
        const userIds = eligibleUsers.map(u => u.user_id);
        const [bonusPointsResult, totalXpResult] = await Promise.all([
            client.query(`SELECT user_id, COALESCE(SUM(points_amount), 0) as total_points FROM bonus_points WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`, [userIds]),
            client.query(`SELECT COALESCE(SUM(xp), 0) as total_xp FROM users WHERE user_id = ANY($1::uuid[])`, [userIds])
        ]);
        const bonusPointsMap = new Map(bonusPointsResult.rows.map(r => [r.user_id, parseFloat(r.total_points)]));
        const totalEligibleXp = parseFloat(totalXpResult.rows[0].total_xp);
        let totalOutstandingBonusPoints = Array.from(bonusPointsMap.values()).reduce((sum, points) => sum + points, 0);
        let remainingRewardPool = numericReward;
        let amountForBuyback = Math.min(remainingRewardPool, totalOutstandingBonusPoints);
        if (amountForBuyback > 0) { remainingRewardPool -= amountForBuyback; }
        let amountForXp = remainingRewardPool;


        for (const user of eligibleUsers) {
            const userId = user.user_id;
            let userBuybackAmount = 0;
            if (amountForBuyback > 0 && totalOutstandingBonusPoints > 0) {
                const userBonusPoints = bonusPointsMap.get(userId) || 0;
                userBuybackAmount = (userBonusPoints / totalOutstandingBonusPoints) * amountForBuyback;
            }

            let userXpAmount = 0;
            if (amountForXp > 0 && totalEligibleXp > 0) {
                const userXp = parseFloat(user.xp) || 0;
                userXpAmount = (userXp / totalEligibleXp) * amountForXp;
            }

            const totalPayout = userBuybackAmount + userXpAmount;
            if (totalPayout <= 0.000001) continue;

            const primaryVaultResult = await client.query(
                `SELECT vault_id FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = ANY($2::int[]) GROUP BY vault_id ORDER BY SUM(amount) DESC LIMIT 1`,
                [userId, participatingVaultIds]
            );
            const targetVaultId = primaryVaultResult.rows[0]?.vault_id || participatingVaultIds[0];

            // --- REFACTORED AND CORRECTED LOGGING ---
            
            // Part 1: Handle Bonus Point Buyback
            if (userBuybackAmount > 0.000001) {
                // --- THIS IS THE FIX: Use a dedicated entry type ---
                await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, fee_amount, status) VALUES ($1, $2, 'DEPOSIT_BUYBACK', $3, 0, 'SWEPT')`, [userId, targetVaultId, userBuybackAmount]);
                
                // Debit bonus points
                await client.query('INSERT INTO bonus_points (user_id, points_amount, source) VALUES ($1, $2, $3)', [userId, -userBuybackAmount, 'HYBRID_DISTRIBUTION_BUYBACK']);
                
                // Create a clear activity log for the USDC gain
                const buybackDesc = `Received ${userBuybackAmount.toFixed(2)} USDC from platform Bonus Point buyback.`;
                await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status, source, related_vault_id) VALUES ($1, 'BONUS_POINT_BUYBACK', $2, $3, 'USDC', 'COMPLETED', 'HYBRID_DISTRIBUTION', $4)`, [userId, buybackDesc, userBuybackAmount, targetVaultId]);

                // Award the associated XP
                await awardXp({
                    userId: userId, xpAmount: userBuybackAmount * 0.1, type: 'BONUS_POINT_BUYBACK',
                    descriptionKey: 'xp_history.hybrid_buyback', descriptionVars: { amount: userBuybackAmount.toFixed(2) },
                    relatedVaultId: targetVaultId 
                }, client);
            }
            
            // Part 2: Handle XP-Weighted Payout
            if (userXpAmount > 0.000001) {
                // Credit the vault as PNL (this is correct)
                await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) VALUES ($1, $2, 'PNL_DISTRIBUTION', $3, 'SWEPT')`, [userId, targetVaultId, userXpAmount]);
                
                // Create a clear activity log for the USDC gain
                const xpDesc = `Received ${userXpAmount.toFixed(2)} USDC from XP-weighted platform rewards.`;
                await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status, source, related_vault_id) VALUES ($1, 'PLATFORM_REWARD', $2, $3, 'USDC', 'COMPLETED', 'HYBRID_DISTRIBUTION', $4)`, [userId, xpDesc, userXpAmount, targetVaultId]);
            }
        }
        
        // Treasury logic is correct and remains unchanged
        await client.query(`UPDATE treasury_ledgers SET balance = balance - $1 WHERE ledger_name = 'FARMING_BUYBACK_POOL'`, [numericReward]);
        const treasuryDesc = `Executed Hybrid Distribution: "${description}". Total: $${numericReward.toFixed(2)}. Admin: ${adminUserId}.`;
        await client.query(`INSERT INTO treasury_transactions (from_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'FARMING_BUYBACK_POOL'), $1, $2)`, [numericReward, treasuryDesc]);

        await client.query('COMMIT');
        res.status(200).json({ message: `Successfully distributed $${numericReward.toFixed(2)} to ${eligibleUsers.length} users.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error executing hybrid distribution:', error);
        res.status(500).json({ error: error.message || 'Failed to execute distribution.' });
    } finally {
        client.release();
    }
});


module.exports = router;
