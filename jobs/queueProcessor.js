// jobs/queueProcessor.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const { getTokenAddress, getTokenAbi } = require('../utils/withdrawHelpers');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');
const tokenMap = require('../utils/tokens/tokenMap');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const { rows } = await pool.query(
    `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at LIMIT 1`
  );

  if (rows.length === 0) return;
  const withdrawal = rows[0];

  const { id, user_id, to_address, amount, token } = withdrawal;
  console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

  try {
    await pool.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const userRow = await pool.query(
      `SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1`,
      [user_id]
    );

    if (userRow.rows.length === 0) throw new Error('User not found');
    const user = userRow.rows[0];

    const decryptedKey = decrypt(user.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(decryptedKey, provider);

    if (token === 'eth') {
      const tx = await wallet.sendTransaction({
        to: to_address,
        value: ethers.utils.parseEther(amount.toString())
      });

      await logAndFinalizeSuccess(user_id, to_address, amount, token, tx.hash, id);
      return;
    }

    // ERC20 logic
    const tokenAddress = getTokenAddress(token);
    const tokenAbi = getTokenAbi();
    const contract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const decimals = tokenMap[token].decimals;
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    // Check gas balance
    await sendEthFromHotWalletIfNeeded(user_id, wallet.address);

    // Get dynamic gas settings
    const feeData = await provider.getFeeData();
    let { maxFeePerGas, maxPriorityFeePerGas } = feeData;

    const cap = ethers.utils.parseUnits("200", "gwei");
    if (maxFeePerGas.gt(cap)) maxFeePerGas = cap;
    if (maxPriorityFeePerGas.gt(cap)) maxPriorityFeePerGas = cap;

    // Prepare transaction
    const txRequest = await contract.populateTransaction.transfer(to_address, parsedAmount);
    txRequest.from = wallet.address;

    // Estimate gas
    const gasEstimate = await provider.estimateGas(txRequest);
    const boostedGasLimit = gasEstimate.mul(101).div(100); // +1%

    const tx = await wallet.sendTransaction({
      to: tokenAddress,
      data: txRequest.data,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit: boostedGasLimit,
    });

    await logAndFinalizeSuccess(user_id, to_address, amount, token, tx.hash, id);
  } catch (err) {
    console.error(`❌ Failed withdrawal #${withdrawal.id}:`, err.message || err);
    await pool.query(`
      UPDATE withdrawal_queue SET status = 'failed', retries = retries + 1 WHERE id = $1
    `, [withdrawal.id]);
  }
}

async function logAndFinalizeSuccess(userId, toAddress, amount, token, txHash, queueId) {
  await pool.query('BEGIN');

  await pool.query(
    `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, toAddress, amount, token, txHash, 'sent']
  );

  await pool.query(
    `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
    [amount, userId]
  );

  await pool.query(
    `UPDATE withdrawal_queue SET status = 'sent' WHERE id = $1`,
    [queueId]
  );

  await pool.query('COMMIT');
  console.log(`✅ Successfully sent ${amount} ${token} to ${toAddress} [tx: ${txHash}]`);
}

module.exports = {
  processWithdrawals
};
