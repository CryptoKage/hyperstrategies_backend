//  hyperstrategies_backend/jobs/pollDeposits.js

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
 * @param {number|string} blockNumber - The block number (hex string or number) to scan.
 */
function normalizeBlockTag(blockNumber) {
  if (typeof blockNumber === 'string') {
    const trimmed = blockNumber.trim();
    if (trimmed.startsWith('0x')) {
      return ethers.BigNumber.from(trimmed).toHexString();
    }
    if (/^\d+$/.test(trimmed)) {
      return ethers.BigNumber.from(trimmed).toHexString();
    }
    // Fallback for unexpected strings like 'latest'.
    return trimmed;
  }

  return ethers.BigNumber.from(blockNumber).toHexString();
}

async function scanBlockForDeposits(blockNumber) {
  console.log(`⚡️ [WebSocket] New block #${blockNumber} received. Scanning for deposits...`);

  const client = await pool.connect();
  try {
    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
      return;
    }
    
    const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

    let blockTag;
    try {
      blockTag = normalizeBlockTag(blockNumber);
    } catch (normalizationError) {
      console.error(`❌ [WebSocket] Unable to normalize block number ${blockNumber}:`, normalizationError);
      return;
    }

    const allTransfers = await alchemy.core.getAssetTransfers({
      fromBlock: blockTag,
      toBlock: blockTag,
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
    });

    if (allTransfers.transfers.length === 0) {
      return;
    }

    for (const event of allTransfers.transfers) {
      const toAddress = event.to?.toLowerCase();
      if (userAddressMap.has(toAddress)) {
        const userId = userAddressMap.get(toAddress);
        const txHash = event.hash;
        
        const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
        if (existingDeposit.rows.length === 0) {
          
          await client.query('BEGIN');
          try {

            const depositAmount_string = event.value;
            console.log(`✅ [WebSocket] New deposit found for user ${userId}: ${depositAmount_string} USDC, tx: ${txHash}`);
            
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
let isSubscribed = false;

function subscribeToNewBlocks() {
  if (isSubscribed) {
    return;
  }

  blockEmitter.on('newBlock', (blockNumber) => {
    scanBlockForDeposits(blockNumber);
  });

  isSubscribed = true;
  console.log('✅ Deposit scanner is now subscribed to new block events from WebSocket.');
}

// We now export the subscription function and the block scanner for manual triggers.
module.exports = { subscribeToNewBlocks, scanBlockForDeposits };
