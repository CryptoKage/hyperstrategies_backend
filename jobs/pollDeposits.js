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
    
    // --- FIX 1: Handle case where system_state is not initialized ---
    if (!lastCheckedBlockResult.rows[0]) {
        throw new Error("FATAL: 'lastCheckedBlock' key not found in system_state table. Please initialize it.");
    }
    const lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    const latestBlock = await alchemy.core.getBlockNumber();

    const lookbackBlocks = 20; // A safe buffer for API data lag and re-orgs
    const potentialFromBlock = lastProcessedBlock - lookbackBlocks;
    
    // --- FIX 2: Clamp fromBlock to prevent negative values ---
    const fromBlock = Math.max(0, potentialFromBlock);
    const toBlock = latestBlock;

    console.log(`Scanning from block #${fromBlock} to #${toBlock}`);
    if (fromBlock >= toBlock) {
      // --- FIX 3: Removed redundant client.release() call ---
      return;
    }

    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
      // --- FIX 3: Removed redundant client.release() call ---
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
          const rawAmount = event.value; // This is a BigNumber object from Alchemy

          // --- FIX 4: Use ethers.utils.formatUnits for safe BigNumber conversion ---
          const depositAmount_string = ethers.utils.formatUnits(rawAmount, tokenMap.usdc.decimals);
          
          console.log(`✅ New USDC deposit detected for user ${userId}: ${depositAmount_string}, tx: ${txHash}`);
          
          await client.query('BEGIN');
          try {
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
          } catch (dbError) {
            await client.query('ROLLBACK');
            console.error(`Database error for tx ${txHash}:`, dbError);
          }
        }
      }
    }

    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [toBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${toBlock}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    // This is the single, correct place to release the client.
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };