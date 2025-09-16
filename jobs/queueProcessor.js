// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/queueProcessor.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { ensureGasCushion } = require('../utils/gas');
const erc20Abi = require('../utils/abis/erc20.json');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processWithdrawals() {
  console.log('🔄 Checking withdrawal queue...');
  const client = await pool.connect();
  let withdrawal = null;

  try {
    const { rows: queuedWithdrawals } = await client.query(
      `SELECT * FROM withdrawal_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
    );

    if (queuedWithdrawals.length === 0) {
      return; 
    }

    withdrawal = queuedWithdrawals[0];
    const { id, user_id, to_address, amount, token } = withdrawal;

    console.log(`⚙️ Processing withdrawal #${id}: ${amount} ${token} → ${to_address}`);
    await client.query(`UPDATE withdrawal_queue SET status = 'processing' WHERE id = $1`, [id]);

    const { rows: users } = await client.query('SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1', [user_id]);
    const user = users[0];

    await ensureGasCushion(user_id, user.eth_address);

    const privateKey = decrypt(user.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(privateKey, provider);
    const tokenInfo = tokenMap[token.toLowerCase()];
    const contract = new ethers.Contract(tokenInfo.address, erc20Abi, wallet);

    const tx = await contract.transfer(
      to_address,
      ethers.utils.parseUnits(amount.toString(), tokenInfo.decimals)
    );

    console.log(`💸 Withdrawal transaction sent: ${tx.hash}`);
    await tx.wait(1);
    console.log(`✅ Withdrawal tx confirmed: ${tx.hash}`);
    
    // --- On Success, we simply move the record to the permanent withdrawals table ---
    // The balance was already deducted, so no further user balance update is needed.
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
    if (client && withdrawal) {
      // ==============================================================================
      // --- REFACTOR: On failure, re-credit the user's balance ---
      // ==============================================================================
      console.log(`Marking withdrawal #${withdrawal.id} as failed and refunding user.`);
      await client.query('BEGIN');
      try {
        // 1. Add the funds back to the user's balance.
        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
            [withdrawal.amount, withdrawal.user_id]
        );
        // 2. Mark the withdrawal as failed so it won't be picked up again.
        await client.query(
            `UPDATE withdrawal_queue SET status = 'failed', error_message = $1 WHERE id = $2`, 
            [err.message, withdrawal.id]
        );
        await client.query('COMMIT');
        console.log(`✅ User ${withdrawal.user_id} has been refunded ${withdrawal.amount}.`);
      } catch (refundErr) {
        await client.query('ROLLBACK');
        console.error(`CRITICAL ERROR: FAILED TO REFUND USER ${withdrawal.user_id} for failed withdrawal #${withdrawal.id}. MANUAL INTERVENTION REQUIRED.`, refundErr);
      }
      // ==============================================================================
      // --- END OF REFACTOR ---
      // ==============================================================================
    }
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = { processWithdrawals };
