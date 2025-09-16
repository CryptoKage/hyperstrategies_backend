// jobs/processVaultWithdrawals.js

const pool = require('../db');

/**
 * A background job that finds and processes pending vault withdrawal requests.
 * This is a database-only operation that credits the user's main balance.
 */
const processPendingVaultWithdrawals = async () => {
  console.log('🔄 Checking for pending vault withdrawals to process...');
  const client = await pool.connect();
  try {
    // --- Step 1: Find all pending withdrawal requests ---
    const { rows: pendingRequests } = await client.query(`
      SELECT activity_id, user_id, amount_primary
      FROM user_activity_log
      WHERE activity_type = 'VAULT_WITHDRAWAL_REQUEST' AND status = 'APPROVED'
    `);

    if (pendingRequests.length === 0) {
      console.log('No pending vault withdrawals to process.');
      return;
    }

    console.log(`Found ${pendingRequests.length} pending vault withdrawal requests.`);

    // --- Step 2: Process each request individually ---
    for (const request of pendingRequests) {
      const { activity_id, user_id, amount_primary } = request;
      const withdrawalAmount = parseFloat(amount_primary);

      if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
        console.error(`Skipping invalid withdrawal request ${activity_id} with amount: ${amount_primary}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        // Add the withdrawn amount back to the user's main balance
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
          [withdrawalAmount, user_id]
        );

        // Update the log entry to mark it as completed
        await client.query(
          "UPDATE user_activity_log SET status = 'COMPLETED' WHERE activity_id = $1",
          [activity_id]
        );
        
        await client.query('COMMIT');
        console.log(`✅ Successfully processed withdrawal request ${activity_id} for user ${user_id}. Credited ${withdrawalAmount} to balance.`);

      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`Error processing withdrawal request ${activity_id}. Rolling back transaction.`, innerErr);
        // We could also update the status to 'FAILED' here if we want to track failures.
        await client.query("UPDATE user_activity_log SET status = 'FAILED' WHERE activity_id = $1", [activity_id]);
      }
    }

  } catch (error) {
    console.error('❌ Major error in the vault withdrawal processor job:', error);
  } finally {
    if (client) {
      client.release();
    }
  }
};

module.exports = {
  processPendingVaultWithdrawals,
};
