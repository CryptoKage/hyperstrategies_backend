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
  console.log('🔄 Checking for new deposits by transaction hash...');
  const client = await pool.connect();
  try {
    const lastCheckedBlockResult = await client.query("SELECT value FROM system_state WHERE key = 'lastCheckedBlock'");
    const lastProcessedBlock = parseInt(lastCheckedBlockResult.rows[0].value, 10);
    const latestBlock = await alchemy.core.getBlockNumber();

    const lookbackBlocks = 20; // A safe buffer for API data lag and re-orgs
    const fromBlock = lastProcessedBlock - lookbackBlocks;
    const toBlock = latestBlock;

    console.log(`Scanning from block #${fromBlock} to #${toBlock}`);
    if (fromBlock >= toBlock) {
      if(client) client.release();
      return;
    }

    const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
    if (users.length === 0) {
      if(client) client.release();
      return;
    }
    
    // Create a fast lookup map of our user addresses
    const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

    // --- The Definitive Query ---
    // Fetch all ERC20 transfers within the block range
    const allTransfers = await alchemy.core.getAssetTransfers({
      fromBlock: ethers.utils.hexlify(fromBlock),
      toBlock: ethers.utils.hexlify(toBlock),
      category: [AssetTransfersCategory.ERC20],
      contractAddresses: [tokenMap.usdc.address], // Only care about USDC for now
      excludeZeroValue: true,
    });

    console.log(`[DEBUG] Found ${allTransfers.transfers.length} potential USDC transfers to filter.`);

    for (const event of allTransfers.transfers) {
      const toAddress = event.to?.toLowerCase();

      // Check if the destination is one of our users
      if (userAddressMap.has(toAddress)) {
        const userId = userAddressMap.get(toAddress);
        const txHash = event.hash;
        
        // This check is the core of the logic. It PREVENTS ALL DUPLICATES.
        const existingDeposit = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);

        if (existingDeposit.rows.length === 0) {
          // This is a brand new, unseen deposit.
          const rawAmount = event.value;
          const amountStr = parseFloat(rawAmount).toFixed(tokenMap.usdc.decimals);
          
          console.log(`✅ New USDC deposit detected for user ${userId}: ${amountStr}, tx: ${txHash}`);
          
          await client.query('BEGIN');
          try {
            await client.query( `INSERT INTO deposits (user_id, amount, "token", tx_hash) VALUES ($1, $2, 'usdc', $3)`, [userId, amountStr, txHash] );
            await client.query( 'UPDATE users SET balance = balance + $1 WHERE user_id = $2', [amountStr, userId] );
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
    if (client) client.release();
  }
}

module.exports = { pollDeposits, initializeProvider };