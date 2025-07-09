// jobs/pollDeposits.js

const { ethers } = require('ethers');
const pool = require('../db');
const { Alchemy, Network } = require('alchemy-sdk'); // We need the full SDK for this
const tokenMap = require('../utils/tokens/tokenMap');

// --- Configuration ---
const config = {
  apiKey: process.env.ALCHEMY_API_KEY, // Use your main API Key
  network: Network.ETH_MAINNET,
};
const alchemy = new Alchemy(config);

// --- Provider Initialization (Simplified) ---
async function initializeProvider() {
  try {
    const block = await alchemy.core.getBlockNumber();
    console.log(`🔌 Alchemy SDK connected to Ethereum Mainnet. Current block: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy SDK connection failed:', err);
  }
}

// --- Main Polling Function ---
async function pollDeposits() {
  console.log('🔄 Checking for new deposits...');
  try {
    const { rows: users } = await pool.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');

    for (const user of users) {
      if (!user.eth_address) continue;

      // Use Alchemy's getAssetTransfers to find all incoming USDC transfers to the user's address
      const transfers = await alchemy.core.getAssetTransfers({
        toAddress: user.eth_address,
        contractAddresses: [tokenMap.usdc.address],
        excludeZeroValue: true,
        category: ["erc20"],
        // For performance, you can add a 'fromBlock' here to only check recent blocks
      });

      for (const event of transfers.transfers) {
        const txHash = event.hash;
        
        // Check if we have already processed this transaction
        const existingDeposit = await pool.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

        if (existingDeposit.rows.length === 0) {
          // This is a new, unseen deposit
          const amount = event.value; // This is the exact amount transferred
          console.log(`✅ New deposit detected for user ${user.user_id}: ${amount} USDC, tx: ${txHash}`);

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // 1. Record the raw deposit with the token and tx_hash
            await client.query(
              `INSERT INTO deposits (user_id, amount, token, tx_hash) 
               VALUES ($1, $2, $3, $4)`,
              [user.user_id, amount, 'USDC', txHash]
            );

            // 2. Apply the 80/20 Bonus Points logic
            const tradableAmount = amount * 0.80;
            const bonusPointsAmount = amount * 0.20;

            // Add 80% to the user's main available balance
            await client.query(
              'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
              [tradableAmount, user.user_id]
            );

            // Add 20% to the bonus_points table
            await client.query(
              'INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)',
              [user.user_id, bonusPointsAmount]
            );

            await client.query('COMMIT');
            console.log(`✅ Successfully processed and credited deposit for tx ${txHash}`);

          } catch (e) {
            await client.query('ROLLBACK');
            console.error(`❌ Failed to process database transaction for tx ${txHash}:`, e);
          } finally {
            client.release();
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in pollDeposits job:', error);
  }
}

module.exports = {
  pollDeposits,
  initializeProvider,
};