// jobs/sendEthFromHotWalletIfNeeded.js

const { ethers } = require('ethers');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const { getProvider } = require('../utils/provider');

const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, getProvider());

async function sendEthFromHotWalletIfNeeded(userId, toAddress, amount, tokenSymbol) {
  console.log(`🔁 [HotWallet] Checking for user=${userId} at ${toAddress}, amount=${amount} ${tokenSymbol}`);
  
  const provider = getProvider();

  try {
    // --- ✅ 1. Input Validation ---
    if (!tokenSymbol) {
      throw new Error('Token symbol is undefined or null.');
    }
    
    const tokenData = tokenMap[tokenSymbol.toLowerCase()];
    if (!tokenData) {
      // This will give a much clearer error if the token is not in your map
      throw new Error(`Token "${tokenSymbol}" not found in tokenMap.`);
    }

    const tokenContract = new ethers.Contract(tokenData.address, tokenData.abi, provider);

    // --- ✅ 2. Defensive Gas Estimation ---
    const userEthBalance = await provider.getBalance(toAddress);
    console.log(`👤 User wallet balance: ${ethers.utils.formatEther(userEthBalance)} ETH`);

    // Estimate gas for the ERC20 transfer
    const gasEstimate = await tokenContract.estimateGas.transfer(
      toAddress, // For estimation, the recipient doesn't matter as much
      ethers.utils.parseUnits(amount.toString(), tokenData.decimals)
    );
    
    const gasPrice = await provider.getGasPrice();
    const estimatedGasCost = gasEstimate.mul(gasPrice);
    const gasBuffer = estimatedGasCost.div(10); // Add a 10% buffer
    const totalGasNeeded = estimatedGasCost.add(gasBuffer);

    console.log(`⛽️ Estimated gas cost for withdrawal: ${ethers.utils.formatEther(totalGasNeeded)} ETH`);

    if (userEthBalance.lt(totalGasNeeded)) {
      const ethToSend = totalGasNeeded.sub(userEthBalance);
      console.log(`⚠️ Insufficient ETH. Attempting to fund ${ethers.utils.formatEther(ethToSend)} ETH from hot wallet.`);

      const tx = await hotWallet.sendTransaction({
        to: toAddress,
        value: ethToSend,
      });

      console.log(`💸 ETH Sent! Hot wallet funding tx: ${tx.hash}`);
      await tx.wait(); // Wait for the transaction to be mined
      console.log(`✅ ETH funding tx ${tx.hash} confirmed.`);

      // Log the funding action
      await pool.query(
        `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
         VALUES ($1, $2, $3, $4)`,
        [userId, toAddress, ethers.utils.formatEther(ethToSend), tx.hash]
      );
    } else {
      console.log('✅ User has sufficient ETH for gas. No funding needed.');
    }
  } catch (error) {
    // This will now catch the error and log it clearly.
    console.error(`❌ Gas funding/estimation failed for user ${userId}:`, error.message);
  }
}

module.exports = {
  sendEthFromHotWalletIfNeeded,
};