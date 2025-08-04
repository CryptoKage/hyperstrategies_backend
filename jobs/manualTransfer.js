// jobs/manualTransfer.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const erc20Abi = require('../utils/abis/erc20.json');
require('dotenv').config();

// --- CONFIGURATION ---
const USER_ID_TO_FIX = '71bd55c5-d7c3-4465-9a0b-31a2c727eb27';
const AMOUNT_TO_SEND = '34.618'; // The 20% Devops Fee
const GAS_PRICE_GWEI = '30';    // Check Etherscan Gas Tracker

const transferFunds = async () => {
  console.log(`--- Starting manual transfer for user ${USER_ID_TO_FIX} ---`);
  const client = await pool.connect();
  
  try {
    // 1. Get required data
    const userResult = await client.query('SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1', [USER_ID_TO_FIX]);
    if (userResult.rows.length === 0) throw new Error('User not found');
    
    const DEVOPS_WALLET_ADDRESS = process.env.DEVOPS_WALLET_ADDRESS;
    if (!DEVOPS_WALLET_ADDRESS) throw new Error('DEVOPS_WALLET_ADDRESS is not set in your .env file');

    const privateKey = decrypt(userResult.rows[0].eth_private_key_encrypted);
    
    // 2. Setup wallet and contract
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = new ethers.Wallet(privateKey, provider);
    const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, userWallet);

    const amount_BN = ethers.utils.parseUnits(AMOUNT_TO_SEND, 6); // USDC has 6 decimals

    // 3. Prepare and send transaction
    console.log(`Preparing to send ${AMOUNT_TO_SEND} USDC from ${userWallet.address} to ${DEVOPS_WALLET_ADDRESS}`);
    
    const tx = await usdcContract.transfer(DEVOPS_WALLET_ADDRESS, amount_BN, {
        gasPrice: ethers.utils.parseUnits(GAS_PRICE_GWEI, 'gwei')
    });

    console.log(`✅ Transaction sent! Hash: ${tx.hash}`);
    console.log('Waiting for confirmation...');
    await tx.wait();
    console.log('🎉 Transaction confirmed!');
    console.log('--- Script finished successfully. You can now update the DB status manually. ---');

  } catch (error) {
    console.error('❌ Script failed:', error.message);
  } finally {
    client.release();
  }
};

transferFunds();