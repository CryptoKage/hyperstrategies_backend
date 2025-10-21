// FINAL jobs/pollDeposits.js

const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { ethers } = require('ethers');

const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });

// The key used in your system_state table. Change this if it's different.
const LAST_SCANNED_BLOCK_KEY = 'lastCheckedBlock';


async function findAndCreditDeposits(options = {}) {
    const { fromBlock, toBlock = 'latest' } = options;
    
    if (!fromBlock) {
        throw new Error("findAndCreditDeposits requires a 'fromBlock' option.");
    }
    
    let client;
    try {
        client = await pool.connect();
        console.log(`[Deposit Scan] Scanning from block ${fromBlock} to ${toBlock}.`);
        
        const { rows: users } = await client.query('SELECT user_id, eth_address FROM users WHERE eth_address IS NOT NULL');
        if (users.length === 0) {
            return { newDeposits: 0, blocksScanned: 0 };
        }
        
        const userAddressMap = new Map(users.map(u => [u.eth_address.toLowerCase(), u.user_id]));

        // This is the robust method that does not rely on the 'toAddress' filter.
        const transfers = await alchemy.core.getAssetTransfers({
            fromBlock: fromBlock,
            toBlock: toBlock,
            category: [AssetTransfersCategory.ERC20],
            contractAddresses: [tokenMap.usdc.address],
            withMetadata: false,
            excludeZeroValue: true,
        });

        let newDepositsFound = 0;
        for (const event of transfers.transfers) {
            const toAddress = event.to?.toLowerCase();
            const txHash = event.hash;

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
        
        const blocksScanned = (parseInt(toBlock, 16) || 0) - (parseInt(fromBlock, 16) || 0);
        console.log(`[Deposit Scan] Finished. Found ${newDepositsFound} new deposits across ~${blocksScanned} blocks.`);
        return { newDeposits: newDepositsFound, blocksScanned };

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ Major error in findAndCreditDeposits:', error);
        throw error;
    } finally {
        if (client) client.release();
    }
}


async function scanForRecentDeposits() {
    let client;
    try {
        client = await pool.connect();
        
        const lastScannedResult = await client.query("SELECT value FROM system_state WHERE key = $1", [LAST_SCANNED_BLOCK_KEY]);
        if (lastScannedResult.rows.length === 0) {
            throw new Error(`System state for '${LAST_SCANNED_BLOCK_KEY}' is not initialized.`);
        }
        const fromBlockNum = parseInt(lastScannedResult.rows[0].value) + 1;

        const latestBlockNum = await alchemy.core.getBlockNumber();
        const toBlockNum = latestBlockNum - 6; // Safety margin for reorgs

        if (fromBlockNum > toBlockNum) {
            console.log(`[Deposit Scan] No new blocks to scan. (from: ${fromBlockNum}, to: ${toBlockNum})`);
            return;
        }

        // We'll scan in chunks of 2000 blocks to stay within API limits.
        const MAX_BLOCK_RANGE = 2000;
        let currentBlock = fromBlockNum;

        while (currentBlock <= toBlockNum) {
            const endBlock = Math.min(currentBlock + MAX_BLOCK_RANGE - 1, toBlockNum);
            
            await findAndCreditDeposits({
                fromBlock: '0x' + currentBlock.toString(16),
                toBlock: '0x' + endBlock.toString(16)
            });

            // Update the state in the database after each successful chunk.
            await client.query("UPDATE system_state SET value = $1 WHERE key = $2", [endBlock, LAST_SCANNED_BLOCK_KEY]);
            console.log(`[Deposit Scan] Cron job scanned up to block ${endBlock}. State updated.`);
            
            currentBlock = endBlock + 1;
        }

    } catch (error) {
        console.error('❌ Scheduled deposit scan job failed:', error.message);
    } finally {
        if (client) client.release();
    }
}

module.exports = { findAndCreditDeposits, scanForRecentDeposits };
