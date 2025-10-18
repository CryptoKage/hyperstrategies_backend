// CORRECTED jobs/pollDeposits.js

const { Alchemy, Network, AssetTransfersCategory } = require('alchemy-sdk');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { ethers } = require('ethers'); // Make sure ethers is imported for the unit conversion fix

const alchemy = new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: Network.ETH_MAINNET });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scanBlockForDeposits(blockNumber, retries = 3) {
    const hexBlockNumber = `0x${blockNumber.toString(16)}`;
    let client;
    
    try {
        client = await pool.connect();
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
                        const rawAmount = event.value;
                        const formattedAmount = ethers.utils.formatUnits(rawAmount, tokenMap.usdc.decimals);
                        
                        await client.query('BEGIN');
                        await client.query('INSERT INTO deposits (user_id, amount, token, tx_hash) VALUES ($1, $2, $3, $4)', [userId, formattedAmount, 'usdc', txHash]);
                        await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [formattedAmount, userId]);
                        await client.query('COMMIT');
                        console.log(`✅ Credited deposit of ${formattedAmount} USDC for user ${userId}. Tx: ${txHash}`);
                    }
                }
            }
        }
    } catch (error) {
        const isPastHeadError = error.code === 'SERVER_ERROR' && error.message?.includes('toBlock is past head');
        if (isPastHeadError && retries > 0) {
            console.warn(`[Deposits] Block #${blockNumber} not yet available on node. Retrying in 2 seconds... (${retries} retries left)`);
            await sleep(2000);
            await scanBlockForDeposits(blockNumber, retries - 1);
            return;
        } else {
            console.error(`❌ Major error in scanBlockForDeposits for block #${blockNumber}:`, error.message);
        }
    } finally {
        if (client) {
            client.release();
        }
    }
}

// All WebSocket-related functions have been removed.

module.exports = { scanBlockForDeposits }; // Only export the one remaining function.
