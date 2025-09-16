// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/pollDeposits.js

const { ethers } = require('ethers');
const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { blockEmitter } = require('../utils/alchemyWebsocketProvider'); // <-- Import the emitter

const config = { apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET };
const alchemy = new Alchemy(config);

/**
 * Scans a specific block for new deposits. This function is now triggered by
 * an event from the WebSocket provider instead of running on a timer.
 * @param {number} blockNumber - The block number to scan.
 */
async function scanBlockForDeposits(blockNumber) {
  console.log(`⚡️ [WebSocket] New block #${blockNumber} received. Scanning for deposits...`);
  
  const client = await pool.connect();
  try {
    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
      return; // No users with wallets to check.
    }
    
    // Create a fast lookup map of user addresses.
    const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

    // Use Alchemy's getAssetTransfers to efficiently find all USDC transfers in this specific block.
    const allTransfers = await alchemy.core.getAssetTransfers({
      fromBlock: ethers.utils.hexlify(blockNumber),
      toBlock: ethers.utils.hexlify(blockNumber), // Scan only this single block
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
    });

    if (allTransfers.transfers.length === 0) {
        // No USDC transfers in this block, we're done.
        return;
    }

    // Process each transfer found in the block.
    for (const event of allTransfers.transfers) {
      const toAddress = event.to?.toLowerCase();
      if (userAddressMap.has(toAddress)) {
        const userId = userAddressMap.get(toAddress);
        const txHash = event.hash;
        
        // Final check to prevent any possible double-processing.
        const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
        if (existingDeposit.rows.length === 0) {
          const depositAmount_string = ethers.utils.formatUnits(event.value, tokenMap.usdc.decimals);
          
          console.log(`✅ [WebSocket] New deposit found for user ${userId}: ${depositAmount_string} USDC, tx: ${txHash}`);
          
          await client.query('BEGIN');
          try {
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
  } catch (error) {
    console.error(`❌ Major error in scanBlockForDeposits for block #${blockNumber}:`, error);
  } finally {
    if (client) client.release();
  }
}

/**
 * Subscribes the deposit scanning logic to the global newBlock event emitter.
 * This should be called once when the server starts up.
 */
function subscribeToNewBlocks() {
    blockEmitter.on('newBlock', (blockNumber) => {
        scanBlockForDeposits(blockNumber);
    });
    console.log('✅ Deposit scanner is now subscribed to new block events from WebSocket.');
}

// We now export the subscription function instead of the pollDeposits function.
module.exports = { subscribeToNewBlocks };
