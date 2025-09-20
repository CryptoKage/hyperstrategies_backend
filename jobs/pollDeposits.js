// /jobs/pollDeposits.js

const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { blockEmitter } = require('../utils/alchemyWebsocketProvider');

const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scanBlockForDeposits(blockNumber, retries = 3) {
    const hexBlockNumber = `0x${blockNumber.toString(16)}`;
    let client; // Define client in the outer scope
    
    try {
        client = await pool.connect(); // Assign the connection to the client
        const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
        if (users.length === 0) return;
        
        const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

        const transfers = await alchemy.core.getAssetTransfers({
            fromBlock: hexBlockNumber,
            toBlock: hexBlockNumber,
            category: [AssetTransfersCategory.ERC20],
            contractAddresses: [tokenMap.usdc.address],
            excludeZeroValue: true,
        });

        if (transfers.transfers.length > 0) {
            console.log(`[Deposits] Found ${transfers.transfers.length} potential USDC transfers in block #${blockNumber}`);
            for (const event of transfers.transfers) {
                const toAddress = event.to?.toLowerCase();
                if (toAddress && userAddressMap.has(toAddress)) {
                    const userId = userAddressMap.get(toAddress);
                    const txHash = event.hash;
                    const { rows: existing } = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
                    if (existing.length === 0) {
                        const amount = event.value;
                        await client.query('BEGIN');
                        await client.query('INSERT INTO deposits (user_id, amount, token, tx_hash) VALUES ($1, $2, $3, $4)', [userId, amount, 'usdc', txHash]);
                        await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [amount, userId]);
                        await client.query('COMMIT');
                        console.log(`✅ Credited deposit of ${amount} USDC for user ${userId}. Tx: ${txHash}`);
                    }
                }
            }
        }
    } catch (error) {
        const isPastHeadError = error.code === 'SERVER_ERROR' && error.message && error.message.includes('toBlock is past head');
        if (isPastHeadError && retries > 0) {
            console.warn(`[Deposits] Block #${blockNumber} not yet available on node. Retrying in 2 seconds... (${retries} retries left)`);
            await sleep(2000);
            // We don't release the client here, we let the recursive call handle its own connection.
            // But we must exit the current function's execution path.
            await scanBlockForDeposits(blockNumber, retries - 1);
            return; // --- THE FIX: Exit immediately after the retry to prevent double release ---
        } else {
            console.error(`❌ Major error in scanBlockForDeposits for block #${blockNumber}:`, error.message);
        }
    } finally {
        if (client) {
            client.release(); // This will now only be called once per successful connection.
        }
    }
}

let isSubscribed = false;
function subscribeToNewBlocks() {
  if (isSubscribed) return;
  blockEmitter.on('newBlock', (blockNumber) => {
    scanBlockForDeposits(blockNumber).catch(err => {
        // Add a top-level catch here to ensure an unhandled error in the async chain doesn't crash the server
        console.error(`[CRITICAL] Unhandled error in scanBlockForDeposits event chain for block #${blockNumber}:`, err);
    });
  });
  isSubscribed = true;
  console.log('👂 Deposit scanner is now subscribed to new block events.');
}

module.exports = { subscribeToNewBlocks, scanBlockForDeposits };
