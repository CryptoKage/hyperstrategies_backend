// utils/gas/sendEthFromHotWalletIfNeeded.js

const { ethers } = require('ethers');
const tokenMap = require('../tokens/tokenMap');
const usdcAbi = require('../tokens/usdcAbi.json');
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const pool = require('../../db');

const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);




async function sendEthFromHotWalletIfNeeded(userId, userAddress, token = 'usdc', amount = '0') {
console.log(`🔁 Checking if ${userAddress} needs ETH for ${amount} ${token}`);  
  const userBalance = await provider.getBalance(userAddress);
  const userEth = parseFloat(ethers.utils.formatEther(userBalance));

  // Estimate dynamic gas cost for the token transfer
  const tokenInfo = tokenMap[token];
  const contract = new ethers.Contract(tokenInfo.address, usdcAbi, provider);

  const tx = await contract.populateTransaction.transfer(
    userAddress, // fake tx to self
    ethers.utils.parseUnits(amount, tokenInfo.decimals)
  );

  tx.from = userAddress;

let gasEstimate, gasPrice, totalGasCost;
try {
  gasEstimate = await provider.estimateGas(tx);
  gasPrice = await provider.getGasPrice();
  totalGasCost = gasEstimate.mul(gasPrice);
  console.log(`🧮 Estimated gas: ${gasEstimate.toString()}, price: ${gasPrice.toString()}, total: ${ethers.utils.formatEther(totalGasCost)} ETH`);
} catch (err) {
  console.error('🔻 Gas estimation failed:', err);
  return null;
}

// 👉 Increase buffer from 1% to 10%
const buffer = totalGasCost.mul(110).div(100);
const bufferEth = parseFloat(ethers.utils.formatEther(buffer));

if (userEth >= bufferEth) {
  console.log(`✅ Wallet has ${userEth.toFixed(6)} ETH, which covers buffered gas cost ${bufferEth.toFixed(6)}. Skipping hot wallet funding.`);
  return null;
}


  const ethNeeded = bufferEth - userEth;

  console.log(`💸 Funding ${ethNeeded.toFixed(6)} ETH to ${userAddress} for gas`);

  const txReceipt = await hotWallet.sendTransaction({
    to: userAddress,
    value: ethers.utils.parseEther(ethNeeded.toFixed(6))
  });

  await pool.query(
    `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, userAddress, ethNeeded.toFixed(6), txReceipt.hash]
  );

  return txReceipt.hash;
}

module.exports = { sendEthFromHotWalletIfNeeded };
