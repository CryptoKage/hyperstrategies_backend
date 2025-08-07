// jobs/pollDeposits.js

const { ethers } = require('ethers');
const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');

const config = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_MAINNET,
};
const alchemy = new Alchemy(config);

async function initializeProvider() {
  try {
    const block = await alchemy.core.getBlockNumber();
    console.log(`🔌 Alchemy SDK connected to Ethereum Mainnet. Current block: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy SDK connection failed:', err);
  }
}

async function pollDeposits() {
  console.log('🔄 Checking for new deposits by transaction hash...');
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    
    if (!lastCheckedBlockResult.rows[0]) {
        throw new Error("FATAL: 'lastCheckedBlock' key not found in system_state table. Please initialize it.");
    }
    const lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    const latestBlock = await alchemy.core.getBlockNumber();

    // --- FIX 1: Add a finality buffer to prevent scanning unconfirmed blocks ---
    const finalityBuffer = 5; // A safe number of blocks to wait for finality
    const toBlock = latestBlock - finalityBuffer;

    const lookbackBlocks = 20;
    const fromBlock = Math.max(0, lastProcessedBlock - lookbackBlocks);
    
    console.log(`Scanning from block #${fromBlock} to #${toBlock}`);
    if (fromBlock >= toBlock) {
      return;
    }

    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
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
          // --- FIX 2: Sanitize the rawAmount to prevent underflow errors ---
          try {
            const rawAmountFromAlchemy = event.value;
            
            // This is the SAFE two-step process.
            // 1. Use parseUnits to safely convert any numeric string (even decimals) into a BigNumber integer.
            const amountAsBigNumber = ethers.utils.parseUnits(
              rawAmountFromAlchemy.toString(), 
              tokenMap.usdc.decimals
            );
            
            // 2. Now that we have a safe BigNumber, format it back to a decimal string for the database.
            const depositAmount_string = ethers.utils.formatUnits(
              amountAsBigNumber, 
              tokenMap.usdc.decimals
            );

            console.log(`✅ New USDC deposit detected for user ${userId}: ${depositAmount_string}, tx: ${txHash}`);
            
            await client.query('BEGIN');
            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`,
              [userId, depositAmount_string, txHash]
            );
            await client.query(
              'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
              [depositAmount_string, userId]
            );
            await client.query('COMMIT');
            console.log(`✅ Successfully processed deposit for tx ${txHash}`);

          } catch (processingError) {
            await client.query('ROLLBACK');
            // If this specific transaction fails to parse, log it and continue with the loop.
            console.error(`-- SKIPPING TX ${txHash} due to processing error:`, processingError.message);
            continue;
          }
        }
      }
    }

    // --- FIX 3: Update the last checked block to the end of our scanned range (toBlock) ---
    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [toBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${toBlock}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };
