// jobs/unstickUserNonce.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
require('dotenv').config();

// --- CONFIGURATION ---
const USER_ID_TO_FIX = '71bd55c5-d7c3-4465-9a0b-31a2c727eb27';
const STUCK_TRANSACTION_NONCE = 3;
const HIGHER_GAS_PRICE_GWEI = '30'; // Re-check Etherscan Gas Tracker before running

const unstickUserTransaction = async () => {
  console.log(`--- Starting User Nonce Unsticking Script for user: ${USER_ID_TO_FIX} ---`);
  const client = await pool.connect();
  
  try {
    // --- THIS IS THE FIX ---
    // The query now selects the correctly named column: 'eth_private_key_encrypted'
    const userResult = await client.query(
      'SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1',
      [USER_ID_TO_FIX]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User with ID ${USER_ID_TO_FIX} not found.`);
    }

    const { eth_address, eth_private_key_encrypted } = userResult.rows[0];
    console.log(`Found wallet address: ${eth_address}`);

    // --- THIS IS THE FIX ---
    // We now pass the correctly named variable to the decrypt function.
    const privateKey = decrypt(eth_private_key_encrypted);
    
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = new ethers.Wallet(privateKey, provider);

    const tx = {
      to: userWallet.address,
      value: ethers.utils.parseEther('0.0'),
      nonce: STUCK_TRANSACTION_NONCE,
      gasPrice: ethers.utils.parseUnits(HIGHER_GAS_PRICE_GWEI, 'gwei'),
    };

    console.log('Prepared unsticking transaction:', tx);
    
    console.log('Sending transaction...');
    const txResponse = await userWallet.sendTransaction(tx);
    console.log(`✅ Transaction sent! Hash: ${txResponse.hash}`);
    console.log('Waiting for transaction to be mined...');

    await txResponse.wait();
    console.log(`🎉 Transaction has been mined! Nonce ${STUCK_TRANSACTION_NONCE} for user ${USER_ID_TO_FIX} is now cleared.`);
    console.log('--- Script finished successfully ---');

  } catch (error) {
    console.error('❌ An error occurred during the unsticking process:', error.message);
  } finally {
    if (client) {
      client.release();
    }
  }
};

unstickUserTransaction();