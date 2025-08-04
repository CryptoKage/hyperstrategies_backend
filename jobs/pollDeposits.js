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
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    let fromBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    
    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    const latestBlock = await alchemy.core.getBlockNumber();

    if (fromBlock >= latestBlock) {
        console.log('No new blocks to scan.');
        if(client) client.release();
        return;
    }

    for (const user of users) {
      if (!user.eth_address) continue;

      try {
        const transfers = await alchemy.core.getAssetTransfers({
          toAddress: user.eth_address,
          contractAddresses: [tokenMap.usdc.address, tokenMap.ape.address],
          excludeZeroValue: true,
          category: ["erc20"],
          fromBlock: `0x${(fromBlock + 1).toString(16)}`,
          toBlock: `0x${latestBlock.toString(16)}`
        });

        if (transfers.transfers.length > 0) {
            console.log(`[DEBUG] Found ${transfers.transfers.length} potential transfers for user ${user.user_id}`);
        }

        for (const event of transfers.transfers) {
          const txHash = event.hash;
          const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

          if (existingDeposit.rows.length === 0) {
            
            console.log(`[DEBUG] Processing new event. Asset: '${event.asset}', Value: ${event.value}`);

            const tokenSymbol = (event.asset || '').toLowerCase();
            const tokenInfo = tokenMap[tokenSymbol];

            if (!tokenInfo) {
              console.warn(`[WARN] Unrecognized token asset '${event.asset}'. Skipping.`);
              continue;
            }

            const rawAmount = event.value;
            const amountStr = parseFloat(rawAmount).toFixed(tokenInfo.decimals);
            
            console.log(`✅ New deposit detected for user ${user.user_id}: ${amountStr} ${tokenSymbol.toUpperCase()}, tx: ${txHash}`);
            
            await client.query('BEGIN');

            await client.query(
              `INSERT INTO deposits (user_id, amount, "token", tx_hash) 
               VALUES ($1, $2, $3, $4)`,
              [user.user_id, amountStr, tokenSymbol, txHash]
            );

            if (tokenSymbol === 'usdc') {
                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
                    [amountStr, user.user_id]
                );
            }

            await client.query('COMMIT');
            console.log(`✅ Successfully processed deposit for tx ${txHash}`);
          }
        }
      } catch (e) {
        if(client) await client.query('ROLLBACK').catch(err => console.error('Rollback failed:', err));
        console.error(`❌ Failed to process deposits for user ${user.user_id}, continuing...`, e);
      }
    }

    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [latestBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${latestBlock}`);

  } catch (error) {
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };