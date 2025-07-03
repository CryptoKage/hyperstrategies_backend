// jobs/sweepGasFees.js
const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWalletAddress = process.env.HOT_WALLET_ADDRESS;

async function sweepGasFees() {
  console.log('🧹 Starting ETH sweep job...');
  const threshold = ethers.utils.parseEther('0.00021'); // reserve for gas

  const { rows: users } = await pool.query(`
    SELECT user_id, eth_address, eth_private_key_encrypted
    FROM users
  `);

  for (const user of users) {
    try {
      const wallet = new ethers.Wallet(decrypt(user.eth_private_key_encrypted), provider);
      const balance = await provider.getBalance(wallet.address);

      if (balance.lte(threshold)) continue; // nothing to sweep

      const gasPrice = await provider.getGasPrice();
      const txCost = gasPrice.mul(21000);

      if (balance.lte(txCost)) continue;

      const sendable = balance.sub(txCost);
      const tx = await wallet.sendTransaction({
        to: hotWalletAddress,
        value: sendable,
        gasLimit: 21000,
        gasPrice
      });

      await pool.query(`
        INSERT INTO gas_fees_sweep_log (user_id, from_address, to_hot_wallet, amount_eth, tx_hash)
        VALUES ($1, $2, $3, $4, $5)
      `, [user.user_id, wallet.address, hotWalletAddress, ethers.utils.formatEther(sendable), tx.hash]);

      console.log(`💸 Swept ${ethers.utils.formatEther(sendable)} ETH from ${wallet.address}`);
    } catch (err) {
      console.error(`❌ Sweep failed for ${user.eth_address}:`, err.message);
    }
  }
}

module.exports = { sweepGasFees };
