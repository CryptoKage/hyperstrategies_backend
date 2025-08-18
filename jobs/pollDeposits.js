const { ethers } = require('ethers');
const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');

const config = { apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET };
const alchemy = new Alchemy(config);

async function initializeProvider() {
  try {
    const block = await alchemy.core.getBlockNumber();
    console.log(`🔌 Alchemy SDK connected to Ethereum Mainnet. Current block: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy SDK connection failed:', err);
  }
}

async function pollDeposits({ toBlock: toBlockOverride } = {}) {
  console.log('🔄 Checking for new deposits...');
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    if (!lastCheckedBlockResult.rows[0]) {
        throw new Error("FATAL: 'lastCheckedBlock' key not found in system_state table.");
    }
    
    const lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    let fromBlock = lastProcessedBlock + 1;
    let toBlock = toBlockOverride;

    // --- THE SIMPLE FIX: Automatically limit the scan range if we are far behind ---
    const MAX_SCAN_RANGE = 250; // Set a safe, smaller number of blocks to scan at once.
    const blockGap = toBlock - fromBlock;

    if (blockGap > MAX_SCAN_RANGE) {
      console.log(`[CATCH-UP MODE] System is ${blockGap} blocks behind. Scanning the next ${MAX_SCAN_RANGE} blocks.`);
      toBlock = fromBlock + MAX_SCAN_RANGE -1; // -1 because the range is inclusive.
    }
    // If the gap is small, it will just scan the few new blocks as normal.
    // --- End of Fix ---

    if (fromBlock > toBlock) {
      console.log('Scanner is up to date. No new blocks to process.');
      return;
    }

    console.log(`Scanning from block #${fromBlock} to #${toBlock}`);
    
    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) return;
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

    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [toBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${toBlock + 1}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };
