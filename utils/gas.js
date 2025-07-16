// server/utils/gas.js

const { ethers } = require('ethers');
const pool = require('../db');
// const { getProvider } = require('./provider'); // <-- REMOVED a faulty import.

// ✅ Create the provider directly inside this utility file. It has no external dependencies.
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

const GAS_CUSHION_ETH = "0.003";

async function ensureGasCushion(userId, userAddress) {
  try {
    const balance_BN = await provider.getBalance(userAddress);
    const requiredBalance_BN = ethers.utils.parseEther(GAS_CUSHION_ETH);

    if (balance_BN.lt(requiredBalance_BN)) {
      const amountToSend_BN = requiredBalance_BN.sub(balance_BN);
      console.log(`⛽️ Funding ${userAddress} with ${ethers.utils.formatEther(amountToSend_BN)} ETH for gas.`);
      
      const tx = await hotWallet.sendTransaction({
        to: userAddress,
        value: amountToSend_BN,
      });

      await pool.query(
        `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
         VALUES ($1, $2, $3, $4)`,
        [userId, userAddress, ethers.utils.formatEther(amountToSend_BN), tx.hash]
      );
      
      console.log(`✅ Gas funding successful. TX: ${tx.hash}. Waiting for confirmation...`);
      await tx.wait(1);
      return tx.hash;
    }
    
    console.log(`✅ User ${userId} has sufficient gas. No funding needed.`);
    return null;

  } catch (error) {
    console.error(`❌ Gas funding failed for user ${userId}:`, error.message);
    return null;
  }
}

module.exports = { ensureGasCushion };