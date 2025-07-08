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

  let gasEstimate, feeData, totalGasCost;
  try {
    const tx = await contract.populateTransaction.transfer(
      userAddress,
      ethers.utils.parseUnits(amount, tokenInfo.decimals)
    );
    tx.from = userAddress;

    gasEstimate = await provider.estimateGas(tx);
    feeData = await provider.getFeeData();

    const gasPrice = feeData.maxFeePerGas || await provider.getGasPrice();
    totalGasCost = gasEstimate.mul(gasPrice);

    console.log(`🧮 Estimated gas: limit=${gasEstimate}, price=${gasPrice}, total=${ethers.utils.formatEther(totalGasCost)} ETH`);
  } catch (err) {
    console.error('🔻 Gas estimation failed:', err);
    return null;
  }

  // Minimum buffer to avoid surprises
  const buffer = totalGasCost.mul(130).div(100); // +30%
  const bufferEth = parseFloat(ethers.utils.formatEther(buffer));
  const MIN_ETH_FOR_GAS = 0.0003; // safer floor
  const requiredEth = Math.max(bufferEth, MIN_ETH_FOR_GAS);

  if (userEth >= requiredEth) {
    console.log(`✅ Wallet has ${userEth.toFixed(6)} ETH, covers required ${requiredEth.toFixed(6)} ETH. No funding needed.`);
    return null;
  }

  // Round up ETH to 6 decimals
  const ethToSend = Math.ceil((requiredEth - userEth) * 1e6) / 1e6;
  console.log(`💸 Funding ${ethToSend} ETH to ${userAddress} for gas`);

  const txReceipt = await hotWallet.sendTransaction({
    to: userAddress,
    value: ethers.utils.parseEther(ethToSend.toFixed(6))
  });

  console.log(`📤 Sent hot wallet TX: ${txReceipt.hash}`);

  await pool.query(
    `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, userAddress, ethToSend.toFixed(6), txReceipt.hash]
  );

  return txReceipt.hash;
}

module.exports = { sendEthFromHotWalletIfNeeded };
