// jobs/pollDeposits.js

const { ethers } = require('ethers');
const { Alchemy, Network } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');

const config = { apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET };
const alchemy = new Alchemy(config);

async function initializeProvider() { /* ... */ }

async function pollDeposits() {
  console.log('🔄 Checking for new USDC deposits...');
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

    // --- SIMPLIFIED LOGIC ---
    // We are now ONLY querying for USDC deposits.
    const transfers = await alchemy.core.getAssetTransfers({
      toAddress: users.map(u => u.eth_address), // Check all user addresses in one go
      contractAddresses: [tokenMap.usdc.address],
      excludeZeroValue: true,
      category: ["erc20"],
      fromBlock: `0x${(fromBlock + 1).toString(16)}`,
      toBlock: `0x${latestBlock.toString(16)}`
    });

    if (transfers.transfers.length > 0) {
      console.log(`[DEBUG] Found ${transfers.transfers.length} total potential USDC transfers.`);
    }

    for (const event of transfers.transfers) {
      const txHash = event.hash;
      const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

      if (existingDeposit.rows.length === 0) {
        const user = users.find(u => u.eth_address.toLowerCase() === event.to.toLowerCase());
        if (!user) continue; // Skip if it's a transfer to an address we don't recognize

        const rawAmount = event.value;
        const amountStr = parseFloat(rawAmount).toFixed(tokenMap.usdc.decimals);
        
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

    await client.query("UPDATE system_state SET value = $1 WHERE key = 'lastCheckedBlock'", [latestBlock]);
    console.log(`✅ Finished scan. Next scan will start from block #${latestBlock}`);

  } catch (error) {
    // --- BETTER ERROR LOGGING ---
    console.error('❌ Major error in pollDeposits job:', error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };