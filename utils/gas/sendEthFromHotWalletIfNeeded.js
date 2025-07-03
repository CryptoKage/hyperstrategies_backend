const { ethers } = require('ethers');
const pool = require('../../db');
const estimateTokenTransferGas = require('../gas/estimateTokenTransferGas');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

async function sendEthFromHotWalletIfNeeded(userId, userAddress, token = 'USDC', amount = '10') {
  try {
    const balance = await provider.getBalance(userAddress);
    const balanceEth = parseFloat(ethers.utils.formatEther(balance));

    const gasEstimate = await estimateTokenTransferGas(token, userAddress, hotWallet.address, amount);
    const requiredEth = parseFloat(gasEstimate.requiredEthFormatted);

    if (balanceEth >= requiredEth) {
      console.log(`✅ User wallet ${userAddress} already has enough ETH (${balanceEth} ETH >= ${requiredEth} ETH).`);
      return null;
    }

    const amountToSend = (requiredEth - balanceEth).toFixed(6);

    const tx = await hotWallet.sendTransaction({
      to: userAddress,
      value: ethers.utils.parseEther(amountToSend)
    });

    await pool.query(`
      INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
      VALUES ($1, $2, $3, $4)
    `, [userId, userAddress, amountToSend, tx.hash]);

    console.log(`🚀 Funded ${amountToSend} ETH to ${userAddress} from hot wallet`);

    return tx.hash;

  } catch (err) {
    console.error('🔥 Hot wallet funding error, falling back to 0.0005 ETH:', err);

    // Fallback minimum funding
    const fallbackAmount = '0.0005';
    const tx = await hotWallet.sendTransaction({
      to: userAddress,
      value: ethers.utils.parseEther(fallbackAmount)
    });

    await pool.query(`
      INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
      VALUES ($1, $2, $3, $4)
    `, [userId, userAddress, fallbackAmount, tx.hash]);

    return tx.hash;
  }
}

module.exports = {
  sendEthFromHotWalletIfNeeded
};