// /utils/gas.js

const { ethers } = require('ethers');
const { getProvider } = require('./provider');
const pool = require('../db');

const provider = getProvider();
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

// The standard amount of gas to ensure a user's wallet has.
const GAS_CUSHION_ETH = "0.003";

/**
 * Checks a user's wallet and sends them a standard ETH cushion if they are below the threshold.
 * This is the ONLY function that should send gas from the Hot Wallet.
 * @param {string} userId - The user's UUID
 * @param {string} userAddress - The user's public ETH address
 * @returns {Promise<string|null>} - The transaction hash if funded, otherwise null.
 */
async function ensureGasCushion(userId, userAddress) {
  try {
    const balance_BN = await provider.getBalance(userAddress);
    const requiredBalance_BN = ethers.utils.parseEther(GAS_CUSHION_ETH);

    if (balance_BN.lt(requiredBalance_BN)) {
      const amountToSend_BN = requiredBalance_BN.sub(balance_BN);
      console.log(`⛽️ Funding ${userAddress} with ${ethers.utils.formatEther(amountToSend_BN)} ETH for gas.`);
      
      const tx = await hotWallet.sendTransaction({
        to: userAddress,
        value: amountToSend_BN
      });

      // Log the funding action
      await pool.query(
        `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
         VALUES ($1, $2, $3, $4)`,
        [userId, userAddress, ethers.utils.formatEther(amountToSend_BN), tx.hash]
      );
      
      console.log(`✅ Gas funding successful. TX: ${tx.hash}. Waiting for confirmation...`);
      await tx.wait(1); // Wait for 1 block confirmation
      return tx.hash;
    }
    
    console.log(`✅ User ${userId} has sufficient gas. No funding needed.`);
    return null;

  } catch (error) {
    console.error(`❌ Gas funding failed for user ${userId}:`, error.message);
    return null; // Return null on failure so the calling job can proceed
  }
}

module.exports = { ensureGasCushion };