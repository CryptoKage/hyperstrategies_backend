// utils/gas/reclaimDustEth.js

const { ethers } = require('ethers');
const pool = require('../../db');
const { decrypt } = require('../walletUtils');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const MIN_RETURN_ETH = ethers.utils.parseEther('0.0001'); // trigger threshold
const LEAVE_BEHIND = ethers.utils.parseEther('0.000005'); // leave dust to avoid full drain

async function reclaimDustEth() {
  console.log(`♻️ Scanning for reclaimable ETH...`);

  const res = await pool.query(`
    SELECT user_id, eth_address, eth_private_key_encrypted
    FROM users
    WHERE eth_address IS NOT NULL
  `);

  for (const user of res.rows) {
    const balance = await provider.getBalance(user.eth_address);

    if (balance.gte(MIN_RETURN_ETH)) {
      const decryptedKey = decrypt(user.eth_private_key_encrypted);
      const wallet = new ethers.Wallet(decryptedKey, provider);

      const amountToSend = balance.sub(LEAVE_BEHIND);
      console.log(`🔁 Reclaiming ${ethers.utils.formatEther(amountToSend)} ETH from ${user.eth_address}`);

      try {
        const tx = await wallet.sendTransaction({
          to: process.env.HOT_WALLET_ADDRESS,
          value: amountToSend
        });

        await pool.query(`
          INSERT INTO hot_wallet_returns (user_id, from_address, amount_eth, tx_hash)
          VALUES ($1, $2, $3, $4)
        `, [user.user_id, user.eth_address, ethers.utils.formatEther(amountToSend), tx.hash]);

        console.log(`✅ Reclaimed to hot wallet: ${tx.hash}`);
      } catch (err) {
        console.warn(`⚠️ Failed to reclaim from ${user.eth_address}: ${err.message}`);
      }
    }
  }

  console.log(`✅ Dust reclaim sweep complete.`);
}

module.exports = { reclaimDustEth };
