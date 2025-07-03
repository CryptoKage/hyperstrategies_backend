// jobs/queueProcessor.js
require('dotenv').config();
const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');
const estimateTokenTransferGas = require('../utils/gas/estimateTokenTransferGas');
const tokenMap = require('../utils/tokenMap');
const usdcAbi = require('../utils/abis/usdcAbi.json');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const { rows: queue } = await pool.query(
    `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
  );

  if (queue.length === 0) return;

  const withdrawal = queue[0];
  const { id, user_id, to_address, amount, token } = withdrawal;
  const tokenInfo = tokenMap[token.toLowerCase()];

  console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

  try {
    await pool.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const {
      rows: [user],
    } = await pool.query(
      `SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1`,
      [user_id]
    );

    const floatAmount = parseFloat(amount);
    if (floatAmount > parseFloat(user.balance)) {
      throw new Error('Insufficient balance in database');
    }

    const decryptedPk = decrypt(user.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(decryptedPk, provider);

    // Estimate dynamic gas
    const { ethCost } = await estimateTokenTransferGas(
      token,
      wallet.address,
      to_address,
      amount
    );
    const gasCostBuffered = parseFloat(ethCost) * 1.01; // Add 1%

    // Send ETH for gas if needed (max cap logic is in that function)
    await sendEthFromHotWalletIfNeeded(user_id, wallet.address);

    // Send token transfer
    const contract = new ethers.Contract(tokenInfo.address, usdcAbi, wallet);
    const decimals = tokenInfo.decimals;
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const tx = await contract.transfer(to_address, parsedAmount);
    await tx.wait();

    await pool.query('BEGIN');

    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'sent')`,
      [user_id, to_address, floatAmount, token, tx.hash]
    );

    // Subtract amount + gas fee in token
    const usdcPerEth = floatAmount / gasCostBuffered; // assumed exchange rate is 1:1, adjusted later
    const tokenFee = gasCostBuffered * usdcPerEth;

    await pool.query(
      `UPDATE users SET balance = balance - $1, usdc_gas_owed = COALESCE(usdc_gas_owed, 0) + $2 WHERE user_id = $3`,
      [floatAmount, tokenFee, user_id]
    );

    await pool.query(
      `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
      [id]
    );

    await pool.query('COMMIT');

    console.log(`✅ Sent ${amount} ${token} for withdrawal #${id}, txHash: ${tx.hash}`);

  } catch (err) {
    console.error(`❌ Failed withdrawal #${withdrawal.id}:`, err.message);
    await pool.query(
      `UPDATE withdrawal_queue SET status = 'failed', retries = retries + 1 WHERE id = $1`,
      [withdrawal.id]
    );
  }
}

module.exports = {
  processWithdrawals,
};
