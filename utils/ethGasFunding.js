const { ethers } = require('ethers');
const pool = require('../db');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

async function sendEthFromHotWalletIfNeeded(userId, userAddress) {
  const balance = await provider.getBalance(userAddress);
  const balanceEth = parseFloat(ethers.utils.formatEther(balance));

  if (balanceEth >= 0.0001) return null; // Already enough for gas

  const amountToSend = "0.0005"; // adjustable
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
}

module.exports = {
  sendEthFromHotWalletIfNeeded
};
