// server/jobs/queueProcessor.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { ensureGasCushion } = require('../utils/gas'); // ✅ THE FIX: Import our new, unified gas utility

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');
  const client = await pool.connect();
  try {
    // Get the oldest, queued withdrawal
    const { rows: queued } = await client.query(
      `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
    );

    if (queued.length === 0) {
      return; // No pending withdrawals
    }

    const withdrawal = queued[0];
    const { id, user_id, to_address, amount, token } = withdrawal;

    console.log(`⚙️ Processing withdrawal #${id}: ${amount} ${token} → ${to_address}`);
    await client.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const { rows: users } = await client.query('SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1', [user_id]);
    const user = users[0];

    // ✅ THE FIX: Use the unified gas funder
    await ensureGasCushion(user_id, user.eth_address);

    const privateKey = decrypt(user.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(privateKey, provider);
    const tokenInfo = tokenMap[token.toLowerCase()];
    const contract = new ethers.Contract(tokenInfo.address, tokenInfo.abi, wallet);

    const tx = await contract.transfer(
      to_address,
      ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals),
      { gasLimit: 100000 } // Set a safe gas limit
    );

    console.log(`💸 Withdrawal transaction sent: ${tx.hash}`);
    await tx.wait(1);
    console.log(`✅ Withdrawal tx confirmed: ${tx.hash}`);
    
    await client.query('BEGIN');
    // Move from queue to final table
    await client.query(`DELETE FROM withdrawal_queue WHERE id = $1`, [id]);
    await client.query(
      `INSERT INTO withdrawals (id, user_id, to_address, amount, token, tx_hash, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'sent')`,
      [user_id, to_address, amount, token, tx.hash]
    );
    await client.query('COMMIT');

  } catch (err) {
    console.error(`❌ FAILED to process withdrawal:`, err.message);
    // If a specific withdrawal ID was being processed, mark it as failed
    if (client && queued && queued[0]) {
      await client.query(`UPDATE withdrawal_queue SET status = 'failed', error_message = $1 WHERE id = $2`, [err.message, queued[0].id]);
    }
  } finally {
    client.release();
  }
}

module.exports = { processWithdrawals };