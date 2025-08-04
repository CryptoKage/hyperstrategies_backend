// jobs/unstickUserNonce.js

const { ethers } = require('ethers');
const pool = require('../db'); // We need the database connection
const { decrypt } = require('../utils/walletUtils'); // We need our decryption utility
require('dotenv').config();

// --- CONFIGURATION ---
const USER_ID_TO_FIX = '71bd55c5-d7c3-4465-9a0b-31a2c727eb27'; // ⚠️ The specific user ID
const STUCK_TRANSACTION_NONCE = 3; // ⚠️ As you identified
const HIGHER_GAS_PRICE_GWEI = '30'; // ⚠️ Check Etherscan Gas Tracker for a good price

const unstickUserTransaction = async () => {
  console.log(`--- Starting User Nonce Unsticking Script for user: ${USER_ID_TO_FIX} ---`);
  const client = await pool.connect();
  
  try {
    // 1. Fetch the user's encrypted key and address from the DB
    const userResult = await client.query(
      'SELECT eth_address, encrypted_private_key FROM users WHERE user_id = $1',
      [USER_ID_TO_FIX]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User with ID ${USER_ID_TO_FIX} not found.`);
    }

    const { eth_address, encrypted_private_key } = userResult.rows[0];
    console.log(`Found wallet address: ${eth_address}`);

    // 2. Decrypt the private key
    const privateKey = decrypt(encrypted_private_key);
    
    // 3. Setup provider and create a wallet instance for the user
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = new ethers.Wallet(privateKey, provider);

    // 4. Construct the "unsticking" transaction
    const tx = {
      to: userWallet.address, // Sending ETH to ourselves
      value: ethers.utils.parseEther('0.0'), // Sending 0 ETH is the cheapest way
      nonce: STUCK_TRANSACTION_NONCE,
      gasPrice: ethers.utils.parseUnits(HIGHER_GAS_PRICE_GWEI, 'gwei'),
      // Let ethers estimate the gas limit for this simple transfer
    };

    console.log('Prepared unsticking transaction:', tx);
    
    // 5. Send the transaction
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
    client.release();
  }
};

unstickUserTransaction();