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
  console.log('🔄 Checking for new USDC deposits...');
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    let lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    const latestBlock = await alchemy.core.getBlockNumber();

    // --- NEW, MORE RESILIENT LOGIC ---
    // 1. Create a safety buffer of a few blocks to prevent missing txs due to API lag.
    const lookbackBlocks = 5; 
    const fromBlock = lastProcessedBlock - lookbackBlocks;
    const toBlock = latestBlock;

    console.log(`Scanning from block #${fromBlock} to #${toBlock} (last processed: #${lastProcessedBlock})`);

    if (fromBlock >= toBlock) {
      console.log('No new blocks to scan.');
      if(client) client.release();
      return;
    }

    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
        console.log('No users with registered addresses to check.');
        if(client) client.release();
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
          fromBlock: ethers.utils.hexlify(fromBlock),
          toBlock: ethers.utils.hexlify(toBlock)
        });

        if (transfers.transfers.length > 0) {
          console.log(`[DEBUG] Found ${transfers.transfers.length} potential transfers for user ${user.user_id}`);
        }

        for (const event of transfers.transfers) {
          const txHash = event.hash;
          // This check is crucial: it prevents us from double-counting deposits from the look-back window.
          const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

          if (existingDeposit.rows.length === 0) {
            const tokenSymbol = (event.asset || '').toLowerCase();
            if (tokenSymbol !== 'usdc') continue;

            const tokenInfo = tokenMap[tokenSymbol];
            if (!tokenInfo) continue;

            const rawAmount = event.value;
            const amountStr = parseFloat(rawAmount).toFixed(tokenInfo.decimals);
            
            console.log(`✅ New USDC deposit detected for user ${user.user_id}: ${amountStr}, tx: ${txHash}`);
            
            await client.query('BEGIN');
            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`,
              [user.user_id, amountStr, txHash]
            );
            await client.query(
              'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
              [amountStr, user.user_id]
            );
            await client.query('COMMIT');
            console.log(`✅ Successfully processed deposit for tx ${txHash}`);
          }
        }
      } catch (e) {
        if(client) await client.query('ROLLBACK').catch(err => console.error('Rollback failed:', err));
        console.error(`❌ Failed to process deposits for user ${user.user_id}, continuing...`, e);
      }
    }

    // --- IMPORTANT ---
    // We update our state with the 'toBlock' we just scanned up to.
    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [toBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${toBlock}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };