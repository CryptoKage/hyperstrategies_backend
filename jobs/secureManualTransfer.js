// secureManualTransfer.js 

const { ethers } = require('ethers');
const pool = require('../db'); // <-- THE ONLY CHANGE IS HERE. We now import the application's configured database pool from db.js
const { decrypt } = require('../utils/walletUtils');
require('dotenv').config();

// Minimal ABI with just the 'transfer' function and 'decimals'
const MINIMAL_ERC20_ABI = [
    {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"payable":false,"stateMutability":"view","type":"function"},
    {"constant":false,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint2c56"}],"name":"transfer","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"}
];

const runTransfer = async () => {
  // 1. READ ARGUMENTS FROM THE COMMAND LINE
  if (process.argv.length < 7) {
    console.error('❌ ERROR: Missing arguments.');
    console.error('Usage: node jobs/secureManualTransfer.js <userId> <tokenContractAddress> <amount> <destinationAddress> <gasPriceInGwei>');
    return;
  }

  const userId = process.argv[2];
  const tokenContractAddress = process.argv[3];
  const amountToTransfer = process.argv[4];
  const destinationAddress = process.argv[5];
  const gasPriceGwei = process.argv[6];

  console.log(`--- Starting Secure Manual Transfer ---`);
  // The 'pool' object imported from '../db' is now used for the connection.
  const client = await pool.connect(); 

  try {
    // 2. Fetch user's key
    const userResult = await client.query('SELECT eth_private_key_encrypted FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) throw new Error(`User with ID ${userId} not found.`);
    
    const privateKey = decrypt(userResult.rows[0].eth_private_key_encrypted);
    
    // 3. Setup Ethers wallet and contract
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = new ethers.Wallet(privateKey, provider);
    const tokenContract = new ethers.Contract(tokenContractAddress, MINIMAL_ERC20_ABI, userWallet);

    const decimals = await tokenContract.decimals();
    const amount_BN = ethers.utils.parseUnits(amountToTransfer, decimals);

    // 4. Final confirmation prompt before sending
    console.log(`\n!!! PLEASE CONFIRM THE DETAILS ARE CORRECT !!!`);
    console.log(`FROM (User Wallet): ${userWallet.address}`);
    console.log(`TO (Destination):   ${destinationAddress}`);
    console.log(`TOKEN CONTRACT:     ${tokenContractAddress}`);
    console.log(`AMOUNT:             ${ethers.utils.formatUnits(amount_BN, decimals)}`);
    console.log(`GAS PRICE:          ${gasPriceGwei} GWEI`);
    console.log(`----------------------------------------------\n`);

    // 5. Send the transaction
    console.log('Sending transaction...');
    const tx = await tokenContract.transfer(destinationAddress, amount_BN, {
        gasPrice: ethers.utils.parseUnits(gasPriceGwei, 'gwei')
    });

    console.log(`✅ Transaction sent! Hash: ${tx.hash}`);
    console.log('Waiting for confirmation...');
    await tx.wait(1);
    console.log('🎉 Transaction confirmed! Funds have been successfully transferred.');
    
  } catch (error) {
    console.error('❌ SCRIPT FAILED:', error.message);
  } finally {
    await client.release();
  }
};

runTransfer();
