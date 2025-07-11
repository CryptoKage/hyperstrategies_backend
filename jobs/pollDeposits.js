// jobs/pollDeposits.js

const { ethers } = require('ethers');
const { Alchemy, Network } = require('alchemy-sdk');
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
  console.log('🔄 Checking for new deposits...');
  try {
    const { rows: users } = await pool.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');

    for (const user of users) {
      if (!user.eth_address) continue;

      const transfers = await alchemy.core.getAssetTransfers({
        toAddress: user.eth_address,
        contractAddresses: [tokenMap.usdc.address],
        excludeZeroValue: true,
        category: ["erc20"],
      });

      for (const event of transfers.transfers) {
        const txHash = event.hash;
        const existingDeposit = await pool.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

        if (existingDeposit.rows.length === 0) {
          const amountStr = event.value.toString();
          console.log(`✅ New deposit detected for user ${user.user_id}: ${amountStr} USDC, tx: ${txHash}`);

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            const depositAmount_BN = ethers.utils.parseUnits(amountStr, 6);
            const depositAmount_formatted = ethers.utils.formatUnits(depositAmount_BN, 6);

            // 1. Record the full, raw deposit
            // ✅ THE FIX: Storing the token symbol as lowercase 'usdc' for consistency
            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) 
               VALUES ($1, $2, $3, $4)`,
              [user.user_id, depositAmount_formatted, 'usdc', txHash]
            );

            // 2. Add 100% of the deposit amount to the user's main 'balance'
            const userBalanceResult = await client.query('SELECT balance FROM users WHERE user_id = $1 FOR UPDATE', [user.user_id]);
            const currentBalance_BN = ethers.utils.parseUnits(userBalanceResult.rows[0].balance.toString(), 6);
            const newBalance_BN = currentBalance_BN.add(depositAmount_BN);

            await client.query(
              'UPDATE users SET balance = $1 WHERE user_id = $2',
              [ethers.utils.formatUnits(newBalance_BN, 6), user.user_id]
            );

            await client.query('COMMIT');
            console.log(`✅ Successfully credited 100% of deposit for tx ${txHash}`);

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