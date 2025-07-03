const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const usdcAbi = require('../utils/tokens/usdcAbi.json');
const { sendEthFromHotWalletIfNeeded } = require('../utils/gas/sendEthFromHotWalletIfNeeded');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const { rows } = await pool.query(
    `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
  );

  if (rows.length === 0) return;

  const withdrawal = rows[0];
  const { id, user_id, to_address, amount, token } = withdrawal;
  const floatAmount = parseFloat(amount);

  console.log(`⚙️ Processing withdrawal #${id} (${floatAmount} ${token}) to ${to_address}`);

  try {
    const userRes = await pool.query(
      'SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1',
      [user_id]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User ${user_id} not found`);
    }

    const { eth_address, eth_private_key_encrypted, balance } = userRes.rows[0];
    const decryptedPrivateKey = decrypt(eth_private_key_encrypted);
    const userWallet = new ethers.Wallet(decryptedPrivateKey, provider);

    if (floatAmount > parseFloat(balance)) {
      throw new Error('Insufficient balance');
    }

    const tokenInfo = tokenMap[token.toLowerCase()];
    if (!tokenInfo) throw new Error('Unsupported token');

    // Fund with ETH if needed (now done before estimation)
    const fundTx = await sendEthFromHotWalletIfNeeded(user_id, eth_address, token, amount);
    if (fundTx) {
      console.log(`💸 Hot wallet sent ETH to ${eth_address} for gas, tx: ${fundTx}`);
      return; // Will retry next poll once funds are confirmed
    }

    const contract = new ethers.Contract(tokenInfo.address, tokenInfo.abi, userWallet);
    const decimals = tokenInfo.decimals;
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const tx = await contract.transfer(to_address, parsedAmount);

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, to_address, floatAmount, token, tx.hash, 'sent']
    );
    await pool.query(
      `UPDATE users SET balance = balance - $1, gas_fee_collected = TRUE WHERE user_id = $2`,
      [floatAmount, user_id]
    );
    await pool.query(
      `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
      [id]
    );
    await pool.query('COMMIT');

    console.log(`✅ Sent withdrawal #${id}, tx: ${tx.hash}`);

  } catch (err) {
    console.error(`❌ Failed withdrawal #${id}:`, err.message);
    await pool.query(
      `UPDATE withdrawal_queue SET status = 'failed', retries = retries + 1 WHERE id = $1`,
      [id]
    );
  }
}

module.exports = {
  processWithdrawals
};
