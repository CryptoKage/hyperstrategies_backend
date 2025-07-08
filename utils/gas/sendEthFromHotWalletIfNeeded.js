const { ethers } = require('ethers');
const tokenMap = require('../tokens/tokenMap');
const usdcAbi = require('../tokens/usdcAbi.json');
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const pool = require('../../db');

const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

async function sendEthFromHotWalletIfNeeded(userId, userAddress, token = 'usdc', amount = '0') {
  console.log(`🔁 [HotWallet] Checking for user=${userId} at ${userAddress}, amount=${amount} ${token}`);
  
  const userBalance = await provider.getBalance(userAddress);
  const userEth = parseFloat(ethers.utils.formatEther(userBalance));
  console.log(`👤 User wallet balance: ${userEth.toFixed(6)} ETH`);

  const tokenInfo = tokenMap[token];
  const contract = new ethers.Contract(tokenInfo.address, usdcAbi, provider);

  const tx = await contract.populateTransaction.transfer(
    userAddress,
    ethers.utils.parseUnits(amount, tokenInfo.decimals)
  );
  tx.from = userAddress;

  // Use fixed safe gas limit
  const FIXED_GAS_LIMIT = ethers.BigNumber.from(60000);
  const gasPrice = await provider.getGasPrice();
  const totalGasCost = FIXED_GAS_LIMIT.mul(gasPrice);

  console.log(`🧮 Estimated gas: limit=${FIXED_GAS_LIMIT.toString()}, price=${gasPrice.toString()}, total=${ethers.utils.formatEther(totalGasCost)} ETH`);

  // Add 25% buffer
  const buffer = totalGasCost.mul(125).div(100);
  const bufferEth = parseFloat(ethers.utils.formatEther(buffer));

  if (userEth >= bufferEth) {
    console.log(`✅ Wallet has ${userEth.toFixed(6)} ETH, enough for buffered gas ${bufferEth.toFixed(6)} ETH`);
    return null;
  }

  const ethNeeded = bufferEth - userEth;

  // Round up to 6 decimals to avoid underfunding
  const ethToSend = Math.ceil(ethNeeded * 1e6) / 1e6;

  console.log(`💸 Funding ${ethToSend.toFixed(6)} ETH to ${userAddress} for gas`);

  const txReceipt = await hotWallet.sendTransaction({
    to: userAddress,
    value: ethers.utils.parseEther(ethToSend.toFixed(6))
  });

  console.log(`📤 Sent hot wallet TX: ${txReceipt.hash}`);

  await pool.query(`
    INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
    VALUES ($1, $2, $3, $4)
  `, [userId, userAddress, ethToSend.toFixed(6), txReceipt.hash]);

  return txReceipt.hash;
}

module.exports = { sendEthFromHotWalletIfNeeded };
