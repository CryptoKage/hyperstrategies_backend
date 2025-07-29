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
  const client = await pool.connect(); // Client is checked out here
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    let fromBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    
    console.log(`Scanning from block #${fromBlock}`);

    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    const latestBlock = await alchemy.core.getBlockNumber();

    // --- ANNOTATION: The fix is here. ---
    if (fromBlock >= latestBlock) {
        console.log('No new blocks to scan.');
        // We REMOVED client.release() from here.
        // We simply return, and the 'finally' block will handle the release.
        return; 
    }

    for (const user of users) {
      if (!user.eth_address) continue;

      try {
        const transfers = await alchemy.core.getAssetTransfers({
          toAddress: user.eth_address,
          contractAddresses: [tokenMap.usdc.address],
          excludeZeroValue: true,
          category: ["erc20"],
          fromBlock: `0x${(fromBlock + 1).toString(16)}`,
          toBlock: `0x${latestBlock.toString(16)}`
        });

        for (const event of transfers.transfers) {
          const txHash = event.hash;
          const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

          if (existingDeposit.rows.length === 0) {
            const amountStr = event.value.toString();
            console.log(`✅ New deposit detected for user ${user.user_id}: ${amountStr} USDC, tx: ${txHash}`);
            
            await client.query('BEGIN');

            const depositAmount_BN = ethers.utils.parseUnits(amountStr, 6);
            const depositAmount_formatted = ethers.utils.formatUnits(depositAmount_BN, 6);

            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) 
               VALUES ($1, $2, $3, $4)`,
              [user.user_id, depositAmount_formatted, 'usdc', txHash]
            );

            const userBalanceResult = await client.query('SELECT balance FROM users WHERE user_id = $1 FOR UPDATE', [user.user_id]);
            const currentBalance_BN = ethers.utils.parseUnits(userBalanceResult.rows[0].balance.toString(), 6);
            const newBalance_BN = currentBalance_BN.add(depositAmount_BN);

            await client.query(
              'UPDATE users SET balance = $1 WHERE user_id = $2',
              [ethers.utils.formatUnits(newBalance_BN, 6), user.user_id]
            );

            await client.query('COMMIT');
            console.log(`✅ Successfully credited 100% of deposit for tx ${txHash}`);
          }
        }
      } catch (e) {
        console.error(`❌ Failed to check deposits for user ${user.user_id}, continuing...`, e);
        // Rollback transaction if it was started
        if (client) await client.query('ROLLBACK').catch(err => console.error('Rollback failed', err));
      }
    }

    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [latestBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${latestBlock}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    // --- ANNOTATION: This is now the ONLY place the client is released. ---
    // It will run for all code paths: success, 'no new blocks', and major errors.
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  pollDeposits,
  initializeProvider,
};