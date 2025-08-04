// jobs/pollDeposits.js

const { ethers } = require('ethers');
// --- NEW --- We need to import the AssetTransfersCategory helper
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
  console.log('🔄 Checking for new deposits by comparing balances...');
  const client = await pool.connect();
  try {
    const { rows: users } = await client.query(
      'SELECT user_id, eth_address, last_known_usdc_balance FROM users WHERE eth_address IS NOT NULL'
    );
    if (users.length === 0) {
      console.log('No users with addresses to check.');
      if(client) client.release();
      return;
    }
    for (const user of users) {
      try {
        const response = await alchemy.core.getTokenBalances(user.eth_address, [tokenMap.usdc.address]);
        const usdcBalanceData = response.tokenBalances[0];
        if (usdcBalanceData.error) {
          console.error(`Error fetching balance for ${user.eth_address}:`, usdcBalanceData.error);
          continue;
        }
        const onChainBalance_BN = ethers.BigNumber.from(usdcBalanceData.tokenBalance);
        const lastKnownBalance_BN = ethers.utils.parseUnits(user.last_known_usdc_balance.toString(), tokenMap.usdc.decimals);

        if (onChainBalance_BN.gt(lastKnownBalance_BN)) {
          const depositAmount_BN = onChainBalance_BN.sub(lastKnownBalance_BN);
          const depositAmountStr = ethers.utils.formatUnits(depositAmount_BN, tokenMap.usdc.decimals);

          console.log(`✅ New deposit detected for user ${user.user_id}: ${depositAmountStr} USDC`);
          
          await client.query('BEGIN');
          try {
            await client.query(
              'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
              [depositAmountStr, user.user_id]
            );
            const newOnChainBalanceStr = ethers.utils.formatUnits(onChainBalance_BN, tokenMap.usdc.decimals);
            await client.query(
              'UPDATE users SET last_known_usdc_balance = $1 WHERE user_id = $2',
              [newOnChainBalanceStr, user.user_id]
            );
            
            // --- THE FIX ---
            // Re-add the insert into the 'deposits' table so it appears on the Admin Dashboard.
            // We use a generated hash as a placeholder since we don't have a real one.
            const placeholderHash = `bal_chg_${Date.now()}_${user.user_id}`;
            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`,
              [user.user_id, depositAmountStr, placeholderHash]
            );
            
            const description = `Detected on-chain deposit of ${depositAmountStr} USDC.`;
            await client.query(
              `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
               VALUES ($1, 'ON_CHAIN_DEPOSIT', $2, $3, 'USDC', 'COMPLETED')`,
              [user.user_id, description, depositAmountStr]
            );
            
            await client.query('COMMIT');
            console.log(`✅ Successfully credited ${depositAmountStr} USDC for user ${user.user_id}`);
          } catch (dbError) {
            await client.query('ROLLBACK');
            console.error('Database error processing deposit:', dbError);
          }
        }
      } catch (e) {
        console.error(`❌ Failed to check balance for user ${user.user_id} (${user.eth_address}):`, e.message);
      }
    }
  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };