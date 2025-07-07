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

  const w = res.rows[0];
  const { id, user_id, to_address, amount, token, gas_funded, last_gas_fund_attempt } = w;
  console.log(`⚙️ Processing withdrawal #${id}: ${amount} ${token} → ${to_address}`);
  await pool.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

  const userRes = await pool.query(`
    SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1
  `, [user_id]);
  const user = userRes.rows[0];
  const decryptedKey = decrypt(user.eth_private_key_encrypted);
  const userWallet = new ethers.Wallet(decryptedKey, provider);
  const tokenData = tokenMap[token];
  if (!tokenData) throw new Error(`Unsupported token ${token}`);
  const contract = new ethers.Contract(tokenData.address, tokenData.abi, userWallet);
  const parsedAmount = ethers.utils.parseUnits(amount.toString(), tokenData.decimals);

  try {
    const txRequest = await contract.populateTransaction.transfer(to_address, parsedAmount);
    txRequest.from = user.eth_address;

    const gasEstimate = await provider.estimateGas(txRequest);
    const gasPrice = await provider.getGasPrice();
    const totalGasCost = gasEstimate.mul(gasPrice);

    const ethBalance = await provider.getBalance(user.eth_address);
    const now = new Date();
    const lastAttempt = last_gas_fund_attempt ? new Date(last_gas_fund_attempt) : null;
    const minutesSinceLast = lastAttempt ? (now - lastAttempt) / 60000 : Infinity;

    console.log(`📊 Gas check: cost=${ethers.utils.formatEther(totalGasCost)}, balance=${ethers.utils.formatEther(ethBalance)}`);

    if (ethBalance.lt(totalGasCost)) {
      console.log(`⚠️ Insufficient ETH (${ethers.utils.formatEther(ethBalance)}) for gas cost.`);
      console.log(`🧪 gas_funded=${gas_funded}, minutesSinceLast=${minutesSinceLast.toFixed(1)}`);

      if (!gas_funded && minutesSinceLast > 2) {
        console.log(`🚀 Triggering hot wallet funding`);
        const txHash = await sendEthFromHotWalletIfNeeded(user_id, user.eth_address, token, amount);

        if (txHash) {
          console.log(`⛽ Hot wallet funded tx: ${txHash}`);
          await pool.query(`
            UPDATE withdrawal_queue
            SET gas_funded = TRUE, retries = retries + 1, status = 'queued', last_gas_fund_attempt = NOW()
            WHERE id = $1
          `, [id]);
        }
      } else {
        console.log(`🛑 Skipping funding: !gas_funded=${!gas_funded}, waited>2min=${minutesSinceLast > 2}`);
      }

      return;
    }
  } catch (gasErr) {
    console.error(`❌ Gas estimate failed: ${gasErr.message}`);
    return;
  }

  const tx = await contract.transfer(to_address, parsedAmount, {
    gasLimit: 50000
  });
  console.log(`✅ Broadcasted TX: ${tx.hash}`);

  await pool.query('BEGIN');
  await pool.query(`
    INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
    VALUES ($1,$2,$3,$4,$5,'sent')
  `, [user_id, to_address, amount, token, tx.hash]);
  await pool.query(`UPDATE users SET balance = balance - $1 WHERE user_id = $2`, [amount, user_id]);
  await pool.query(`DELETE FROM withdrawal_queue WHERE id = $1`, [id]);
  await pool.query('COMMIT');
  console.log(`🏁 Withdrawal #${id} completed.`);
}

module.exports = { processWithdrawals };
