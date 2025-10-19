// jobs/pollDeposits.js

const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { ethers } = require('ethers');

// Initialize a single Alchemy instance for this module
const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });

/**
 * A robust, batched function to scan for USDC deposits for all users.
 * Can be used for both periodic polling and manual admin-triggered syncs.
 * @param {object} [options] - Optional parameters for the scan.
 * @param {string} [options.fromBlock] - The starting block number (hex). If null, starts from a recent block.
 * @param {string} [options.toBlock='latest'] - The ending block number (hex).
 */
async function findAndCreditDeposits(options = {}) {
    const { fromBlock = null, toBlock = 'latest' } = options;
    
    let client;
    try {
        client = await pool.connect();
        
        console.log(`[Deposit Scan] Starting scan from block ${fromBlock || 'recent'} to ${toBlock}.`);
        
        // 1. Fetch all user addresses ONCE.
        const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
        if (users.length === 0) {
            console.log('[Deposit Scan] No users with registered deposit addresses found.');
            return { newDeposits: 0, usersChecked: 0 };
        }
        
        // Use a Map for efficient lookups.
        const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

        // 2. Make ONE batched API call to Alchemy, but WITHOUT the 'toAddress' filter.
        const transfers = await alchemy.core.getAssetTransfers({
            fromBlock: fromBlock,
            toBlock: toBlock,
            // toAddress: userAddresses, // <-- THIS IS THE LINE WE ARE REMOVING
            category: [AssetTransfersCategory.ERC20],
            contractAddresses: [tokenMap.usdc.address],
            withMetadata: false,
            excludeZeroValue: true,
        });

        let newDepositsFound = 0;
        // 3. Process the results. This logic remains the same.
        for (const event of transfers.transfers) {
            const toAddress = event.to?.toLowerCase();
            const txHash = event.hash;

            // Our own code now does the filtering. This is reliable.
            if (toAddress && userAddressMap.has(toAddress)) {
                const { rows: existing } = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
                if (existing.length === 0) {
                    const userId = userAddressMap.get(toAddress);
                    const rawAmount = event.value;
                    const formattedAmount = ethers.utils.formatUnits(rawAmount, tokenMap.usdc.decimals);

                    await client.query('BEGIN');
                    await client.query('INSERT INTO deposits (user_id, amount, token, tx_hash) VALUES ($1, $2, $3, $4)', [userId, formattedAmount, 'usdc', txHash]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [formattedAmount, userId]);
                    await client.query('COMMIT');
                    
                    console.log(`✅ [Deposit Scan] Credited deposit of ${formattedAmount} USDC for user ${userId}. Tx: ${txHash}`);
                    newDepositsFound++;
                }
            }
        }
        
        console.log(`[Deposit Scan] Finished. Found ${newDepositsFound} new deposits.`);
        return { newDeposits: newDepositsFound, usersChecked: users.length };

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ Major error in findAndCreditDeposits:', error);
        throw error;
    } finally {
        if (client) client.release();
    }
}


/**
 * A wrapper function for the scheduled cron job.
 * Scans the last 100 blocks (approx. 20 minutes) for any deposits.
 */
async function scanForRecentDeposits() {
    try {
        const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = '0x' + (latestBlock - 100).toString(16); // Scan last ~20 mins

        await findAndCreditDeposits({ fromBlock });
    } catch (error) {
        console.error('❌ Scheduled deposit scan job failed:', error.message);
    }
}

module.exports = { findAndCreditDeposits, scanForRecentDeposits };
