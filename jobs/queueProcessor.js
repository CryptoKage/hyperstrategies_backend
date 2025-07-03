// server/jobs/queueProcessor.js
const { ethers } = require('ethers');
const pool = require('../db');
const { getUserWallet, getTokenAddress, getTokenAbi } = require('../utils/withdrawHelpers');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const { rows: queue } = await pool.query(`
    SELECT * FROM withdrawal_queue
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 5
  `);

  for (const withdrawal of queue) {
    const { id, user_id, to_address, amount, token, retries } = withdrawal;

    try {
      console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

      // Step 1: Fund ETH if needed
      await sendEthFromHotWalletIfNeeded(user_id, to_address);

      // Step 2: Get wallet and contract
      const wallet = await getUserWallet(user_id);
      const tokenAddress = getTokenAddress(token);
      const tokenAbi = getTokenAbi();
      const contract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

      const decimals = await contract.decimals();
      const formattedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

      // Step 3: Send token
      const tx = await contract.transfer(to_address, formattedAmount);
      console.log(`✅ Sent ${amount} ${token} tx: ${tx.hash}`);

      // Step 4: Log + update DB
      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO withdrawals (user_id, to_address, amount, tx_hash, status)
         VALUES ($1, $2, $3, $4, 'sent')`,
        [user_id, to_address, amount, tx.hash]
      );
      await pool.query(
        `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
        [id]
      );
      await pool.query('COMMIT');

    } catch (err) {
      console.error(`❌ Failed withdrawal #${id}:`, err.message || err);

      await pool.query(
        `UPDATE withdrawal_queue SET status = $1, retries = retries + 1 WHERE id = $2`,
        [retries >= 3 ? 'failed' : 'queued', id]
      );
    }
  }
}

module.exports = { processWithdrawals };
