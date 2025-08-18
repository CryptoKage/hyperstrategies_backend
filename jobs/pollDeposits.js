const { ethers } = require('ethers');
const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');

const config = { apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET };
const alchemy = new Alchemy(config);

async function pollDeposits({ fromBlock: fromBlockOverride, toBlock: toBlockOverride } = {}) {
  const jobTitle = fromBlockOverride ? '[ADMIN SCAN]' : '🔄';
  console.log(`${jobTitle} Checking for new deposits by transaction hash...`);
  
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    if (!lastCheckedBlockResult.rows[0]) {
        throw new Error("FATAL: 'lastCheckedBlock' key not found in system_state table.");
    }
    const lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);

    // If the admin tool provides a fromBlock, use it. Otherwise, use the one from the database.
    let fromBlock = fromBlockOverride || (lastProcessedBlock + 1);
    let toBlock;

    if (toBlockOverride) {
      toBlock = toBlockOverride; // Use admin-provided toBlock
    } else {
      const latestBlock = await alchemy.core.getBlockNumber();
      const finalityBuffer = 5;
      toBlock = latestBlock - finalityBuffer;
    }
    
    // The simple catch-up logic
    const MAX_SCAN_RANGE = 500;
    if (!fromBlockOverride && (toBlock - fromBlock) > MAX_SCAN_RANGE) {
      console.log(`[CATCH-UP MODE] Scanner is far behind. Processing a chunk of ${MAX_SCAN_RANGE} blocks.`);
      toBlock = fromBlock + MAX_SCAN_RANGE - 1;
    }

    if (fromBlock > toBlock) {
      if (!toBlockOverride) console.log('Scanner is up to date. No new blocks to process.');
      return;
    }

    console.log(`Scanning from block #${fromBlock} to #${toBlock}`);
    
    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
      client.release();
      return;
    }
    
    const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

    const allTransfers = await alchemy.core.getAssetTransfers({
      fromBlock: ethers.utils.hexlify(fromBlock),
      toBlock: ethers.utils.hexlify(toBlock),
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
    });

    console.log(`[DEBUG] Found ${allTransfers.transfers.length} potential USDC transfers to filter.`);

    for (const event of allTransfers.transfers) {
      const toAddress = event.to?.toLowerCase();
      if (userAddressMap.has(toAddress)) {
        const userId = userAddressMap.get(toAddress);
        const txHash = event.hash;
        
        const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
        if (existingDeposit.rows.length === 0) {
          try {
            const depositAmount_string = ethers.utils.formatUnits(event.value, tokenMap.usdc.decimals);
            console.log(`✅ New USDC deposit detected for user ${userId}: ${depositAmount_string}, tx: ${txHash}`);
            await client.query('BEGIN');
            await client.query(`INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`, [userId, depositAmount_string, txHash]);
            await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [depositAmount_string, userId]);
            await client.query('COMMIT');
          } catch (processingError) {
            await client.query('ROLLBACK');
            console.error(`-- SKIPPING TX ${txHash} due to processing error:`, processingError.message);
          }
        }
      }
    }

    // Only update the main scanner's state if we are NOT doing a manual admin override.
    if (!fromBlockOverride) {
      await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [toBlock]);
      console.log(`✅ Finished automated scan. Next scan will start from block #${toBlock + 1}`);
    } else {
      console.log(`✅ Finished manual scan of block range ${fromBlock}-${toBlock}.`);
    }

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
    // Throw the error so the admin endpoint knows the manual scan failed.
    if (fromBlockOverride) {
      throw error;
    }
  } finally {
    if (client) client.release();
  }
}

// We no longer need initializeProvider, it's handled internally by the Alchemy SDK.
module.exports = { pollDeposits };
