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

const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });


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
          AND log.status NOT IN ('COMPLETED', 'FAILED') -- <-- THIS IS THE FIX
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
      `SELECT user_id, amount_primary 
       FROM user_activity_log 
       WHERE activity_id = $1 AND status = 'SWEEP_CONFIRMED' FOR UPDATE`, // Lock the row
      [activityId]
    );

    if (requestResult.rows.length === 0) {
      throw new Error('Withdrawal request not found or not in the correct state for finalization.');
    }
    const request = requestResult.rows[0];
    const { user_id, amount_primary } = request;
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

module.exports = router;
