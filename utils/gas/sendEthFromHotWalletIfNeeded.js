const { ethers } = require('ethers');
const pool = require('../../db');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

/**
 * Sends ETH from the hot wallet to the user address if gas is insufficient.
 * @param {string} userId - UUID of the user in DB
 * @param {string} userAddress - Ethereum address of the user
 */
async function sendEthFromHotWalletIfNeeded(userId, userAddress) {
  const balance = await provider.getBalance(userAddress);
  const gasPrice = await provider.getGasPrice();
  const estimatedGasLimit = ethers.BigNumber.from(55000); // Typical ERC20 tx
  const estimatedGasCost = gasPrice.mul(estimatedGasLimit);

  // Add a 10% buffer
  const buffer = estimatedGasCost.mul(10).div(100);
  const totalNeeded = estimatedGasCost.add(buffer);

  if (balance.gte(totalNeeded)) {
    return null; // Enough ETH, do nothing
  }

  // Cap funding to 0.001 ETH
  const cap = ethers.utils.parseEther("0.007");
  const amountToSend = totalNeeded.gt(cap) ? cap : totalNeeded;

  const tx = await hotWallet.sendTransaction({
    to: userAddress,
    value: amountToSend,
  });

  await pool.query(`
    INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
    VALUES ($1, $2, $3, $4)
  `, [userId, userAddress, ethers.utils.formatEther(amountToSend), tx.hash]);

  console.log(`🚀 Funded ${ethers.utils.formatEther(amountToSend)} ETH to ${userAddress} from hot wallet`);

  return tx.hash;
}

module.exports = {
  sendEthFromHotWalletIfNeeded
};
