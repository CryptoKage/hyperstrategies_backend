// server/jobs/queueProcessor.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { ensureGasCushion } = require('../utils/gas');
const erc20Abi = require('../utils/abis/erc20.json'); // Import the shared ABI

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');
  const client = await pool.connect();
  
  // --- THIS IS THE FIX ---
  // We declare 'withdrawal' here, in the higher scope.
  let withdrawal = null;

  try {
    const { rows: queuedWithdrawals } = await client.query(
      `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
    );

    if (queuedWithdrawals.length === 0) {
      if (client) client.release(); // Release client early if no work
      return;
    }

    // Assign the found withdrawal to our higher-scope variable
    withdrawal = queuedWithdrawals[0];
    const { id, user_id, to_address, amount, token } = withdrawal;

    console.log(`⚙️ Processing withdrawal #${id}: ${amount} ${token} → ${to_address}`);
    await client.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const { rows: users } = await client.query('SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1', [user_id]);
    const user = users[0];

    // Note: ensureGasCushion will be addressed later as requested.
    await ensureGasCushion(user_id, user.eth_address);

    const privateKey = decrypt(user.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(privateKey, provider);
    const tokenInfo = tokenMap[token.toLowerCase()];
    
    // Use the shared, correct ABI
    const contract = new ethers.Contract(tokenInfo.address, erc20Abi, wallet);

    const tx = await contract.transfer(
      to_address,
      ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals)
    );

    console.log(`💸 Withdrawal transaction sent: ${tx.hash}`);
    await tx.wait(1);
    console.log(`✅ Withdrawal tx confirmed: ${tx.hash}`);
    
    await client.query('BEGIN');
    await client.query(`DELETE FROM withdrawal_queue WHERE id = $1`, [id]);
    await client.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'sent')`,
      [user_id, to_address, amount, token, tx.hash]
    );
    await client.query('COMMIT');

  } catch (err) {
    console.error(`❌ FAILED to process withdrawal:`, err.message);
    // --- THIS IS THE FIX ---
    // We now check our higher-scope 'withdrawal' variable.
    if (client && withdrawal) {
      console.log(`Marking withdrawal #${withdrawal.id} as failed.`);
      await client.query(`UPDATE withdrawal_queue SET status = 'failed', error_message = $1 WHERE id = $2`, [err.message, withdrawal.id]);
    }
  } finally {
    if (client) client.release();
  }
}

module.exports = { processWithdrawals };