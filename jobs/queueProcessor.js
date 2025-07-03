// server/jobs/queueProcessor.js
const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');
const { getTokenAddress, getTokenAbi } = require('../utils/withdrawHelpers');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  try {
    const { rows: queue } = await pool.query(
      `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
    );

    if (queue.length === 0) return;

    const request = queue[0];
    const { id, user_id, to_address, amount, token } = request;

    console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

    // Lock item
    await pool.query(
      `UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`,
      [id]
    );

    const userRes = await pool.query(
      `SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1`,
      [user_id]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User ${user_id} not found`);
    }

    const { eth_address, eth_private_key_encrypted, balance } = userRes.rows[0];

    const decryptedKey = decrypt(eth_private_key_encrypted);
    const wallet = new ethers.Wallet(decryptedKey, provider);

    const floatAmount = parseFloat(amount);
    if (floatAmount > parseFloat(balance)) {
      throw new Error(`Insufficient balance for withdrawal`);
    }

    if (token === 'eth') {
      const tx = await wallet.sendTransaction({
        to: to_address,
        value: ethers.utils.parseEther(amount.toString())
      });

      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
         VALUES ($1, $2, $3, $4, $5, 'sent')`,
        [user_id, to_address, floatAmount, token, tx.hash]
      );
      await pool.query(
        `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
        [floatAmount, user_id]
      );
      await pool.query(
        `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
        [id]
      );
      await pool.query('COMMIT');

      console.log(`✅ ETH Withdrawal #${id} sent: ${tx.hash}`);
      return;
    }

    // ERC-20 token withdrawal
    await sendEthFromHotWalletIfNeeded(user_id, eth_address); // ensure gas

    const tokenAddress = getTokenAddress(token);
    const tokenAbi = getTokenAbi();
    const contract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

    const decimals = await contract.decimals();
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const tx = await contract.transfer(to_address, parsedAmount);

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'sent')`,
      [user_id, to_address, floatAmount, token, tx.hash]
    );
    await pool.query(
      `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
      [floatAmount, user_id]
    );
    await pool.query(
      `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
      [id]
    );
    await pool.query('COMMIT');

    console.log(`✅ Token Withdrawal #${id} sent: ${tx.hash}`);
  } catch (err) {
    console.error(`❌ Failed withdrawal #${err.id || '?'}:`, err.message);

    await pool.query(
      `UPDATE withdrawal_queue
       SET status = 'queued', retries = retries + 1
       WHERE status = 'processing' AND retries < 5`
    );
  }
}

module.exports = { processWithdrawals };
