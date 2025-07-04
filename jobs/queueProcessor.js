const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { sendEthFromHotWalletIfNeeded } = require('../utils/gas/sendEthFromHotWalletIfNeeded');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');

  const res = await pool.query(`
    SELECT * FROM withdrawal_queue
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
  `);

  if (res.rows.length === 0) return;

  const withdrawal = res.rows[0];
  const { id, user_id, to_address, amount, token, gas_funded } = withdrawal;

  console.log(`⚙️ Processing withdrawal #${id} (${amount} ${token}) to ${to_address}`);

  try {
    await pool.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const userRes = await pool.query(`
      SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1
    `, [user_id]);

    const user = userRes.rows[0];
    const decryptedKey = decrypt(user.eth_private_key_encrypted);
    const userWallet = new ethers.Wallet(decryptedKey, provider);

    const tokenData = tokenMap[token];
    if (!tokenData) throw new Error(`❌ Unsupported token ${token}`);

    const contract = new ethers.Contract(tokenData.address, tokenData.abi, userWallet);
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), tokenData.decimals);

    // Try estimating gas (this will fail if there's not enough ETH)
    let gasLimit, gasPrice, totalGasCost;
    try {
      const txRequest = await contract.populateTransaction.transfer(to_address, parsedAmount);
      txRequest.from = user.eth_address;

      gasLimit = await provider.estimateGas(txRequest);
      gasPrice = await provider.getGasPrice();
      totalGasCost = gasLimit.mul(gasPrice);

      const ethBalance = await provider.getBalance(user.eth_address);

 if (ethBalance.lt(totalGasCost)) {
  console.log(`⚠️ ${user.eth_address} has insufficient ETH (${ethers.utils.formatEther(ethBalance)}), needs ${ethers.utils.formatEther(totalGasCost)}.`);

  let txHash = null;

  if (!gas_funded) {
    txHash = await sendEthFromHotWalletIfNeeded(user_id, user.eth_address);

    if (txHash) {
      console.log(`⛽ Funded gas for user ${user.eth_address} with TX: ${txHash}`);
      await pool.query(`
        UPDATE withdrawal_queue
        SET gas_funded = TRUE, retries = retries + 1, status = 'queued'
        WHERE id = $1
      `, [id]);
    } else {
      console.log(`⚠️ Could not fund ${user.eth_address} with ETH — likely already pending or failed.`);
    }
  } else {
    console.log(`💤 Already funded gas, waiting for ETH to arrive in ${user.eth_address}`);
  }

  return;
}

    } catch (gasErr) {
      console.error(`❌ Failed estimating gas: ${gasErr.message}`);
      if (!gas_funded) {
        const txHash = await sendEthFromHotWalletIfNeeded(user_id, user.eth_address);
        if (txHash) {
          console.log(`⛽ Funded ETH via hot wallet: ${txHash}`);
          await pool.query(`
            UPDATE withdrawal_queue SET gas_funded = TRUE, retries = retries + 1, status = 'queued'
            WHERE id = $1
          `, [id]);
        }
      }
      return;
    }

    // Proceed with the actual transfer
    const tx = await contract.transfer(to_address, parsedAmount);
    console.log(`✅ Broadcasted TX: ${tx.hash}`);

    // Update balances & logs
    await pool.query('BEGIN');
    await pool.query(`
      INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
      VALUES ($1, $2, $3, $4, $5, 'sent')
    `, [user_id, to_address, amount, token, tx.hash]);
    await pool.query(`
      UPDATE users SET balance = balance - $1 WHERE user_id = $2
    `, [amount, user_id]);
    await pool.query(`
      DELETE FROM withdrawal_queue WHERE id = $1
    `, [id]);
    await pool.query('COMMIT');

    console.log(`✅ Withdrawal #${id} completed and recorded.`);
  } catch (err) {
    console.error(`❌ Withdrawal #${id} failed: ${err.message}`);

    await pool.query(`
      UPDATE withdrawal_queue
      SET status = 'queued', retries = retries + 1
      WHERE id = $1
    `, [id]);
  }
}

module.exports = {
  processWithdrawals
};
