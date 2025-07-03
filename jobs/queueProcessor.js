// jobs/queueProcessor.js
const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap'); 
const usdcAbi = require('../utils/tokens/usdcAbi.json');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding/sendEthFromHotWalletIfNeeded');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const { rows: queue } = await pool.query(`
    SELECT * FROM withdrawal_queue
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 5
  `);

  for (const job of queue) {
    const { id, user_id, to_address, amount, token } = job;

    console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

    try {
      await pool.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

      const {
        rows: [user],
      } = await pool.query(
        `SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1`,
        [user_id]
      );

      const decryptedPk = decrypt(user.eth_private_key_encrypted);
      const wallet = new ethers.Wallet(decryptedPk, provider);

      // ✅ Ensure enough ETH is available for gas
      await sendEthFromHotWalletIfNeeded(user_id, user.eth_address, token, amount);

      const tokenInfo = tokenMap[token];
      const contract = new ethers.Contract(tokenInfo.address, usdcAbi, wallet);

      const parsedAmount = ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals);
      const tx = await contract.transfer(to_address, parsedAmount);

      await pool.query('BEGIN');

      await pool.query(
        `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
         VALUES ($1, $2, $3, $4, $5, 'sent')`,
        [user_id, to_address, amount, token, tx.hash]
      );

      await pool.query(
        `UPDATE users SET balance = balance - $1, gas_fee_collected = gas_fee_collected + $2 WHERE user_id = $3`,
        [amount, amount, user_id]
      );

      await pool.query(`UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`, [id]);
      await pool.query('COMMIT');

      console.log(`✅ Sent ${amount} ${token} in tx ${tx.hash}`);
    } catch (err) {
      console.error(`❌ Failed withdrawal #${id}:`, err.message);
      await pool.query(`UPDATE withdrawal_queue SET status = 'failed', retries = retries + 1 WHERE id = $1`, [id]);
      await pool.query('ROLLBACK');
    }
  }
}

module.exports = { processWithdrawals };
