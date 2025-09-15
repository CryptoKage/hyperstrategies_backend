// ==============================================================================
// START: PASTE THIS ENTIRE BLOCK into your new jobs/verifyWithdrawalSweeps.js
// ==============================================================================
const pool = require('../db');
const { ethers } = require('ethers');

/**
 * A background job that finds withdrawal sweeps pending confirmation and verifies
 * their on-chain status.
 */
const verifyWithdrawalSweeps = async () => {
  console.log('🔍 Checking for pending withdrawal sweeps to verify...');
  const client = await pool.connect();
  try {
    // 1. Get all requests that have been swept but not yet confirmed
    const { rows: pendingSweeps } = await client.query(`
      SELECT activity_id, related_sweep_tx_hash
      FROM user_activity_log
      WHERE status = 'PENDING_CONFIRMATION'
    `);

    if (pendingSweeps.length === 0) {
      console.log('No pending sweeps to verify.');
      return;
    }

    console.log(`Found ${pendingSweeps.length} pending sweeps to verify.`);
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const REQUIRED_CONFIRMATIONS = 3; // A safe number of block confirmations

    for (const sweep of pendingSweeps) {
      const { activity_id, related_sweep_tx_hash } = sweep;
      try {
        console.log(`-- Verifying sweep for activity ID ${activity_id}, hash: ${related_sweep_tx_hash}`);
        
        const txReceipt = await provider.getTransactionReceipt(related_sweep_tx_hash);

        // Check if the transaction exists and was successful
        if (!txReceipt || txReceipt.status === 0) {
          throw new Error('Transaction either not found, failed, or was reverted on-chain.');
        }

        // Check for sufficient block confirmations
        if (txReceipt.confirmations < REQUIRED_CONFIRMATIONS) {
          console.log(`   - Hash ${related_sweep_tx_hash} has only ${txReceipt.confirmations}/${REQUIRED_CONFIRMATIONS} confirmations. Will check again later.`);
          continue; // Skip this one for now, will re-verify in the next run
        }

        // If all checks pass, update the status to 'SWEEP_CONFIRMED'
        await client.query(
          "UPDATE user_activity_log SET status = 'SWEEP_CONFIRMED' WHERE activity_id = $1",
          [activity_id]
        );
        console.log(`   - ✅ Successfully verified and confirmed sweep for activity ID ${activity_id}.`);

      } catch (verificationError) {
        console.error(`   - ❌ FAILED to verify sweep for activity ID ${activity_id}. Error:`, verificationError.message);
        // If verification fails, we mark it so an admin can investigate.
        await client.query(
          "UPDATE user_activity_log SET status = 'SWEEP_FAILED' WHERE activity_id = $1",
          [activity_id]
        );
      }
    }
  } catch (error) {
    console.error('❌ Major error in the sweep verification job:', error);
  } finally {
    if (client) {
      client.release();
    }
    console.log('🔍 Sweep verification job finished.');
  }
};

module.exports = {
  verifyWithdrawalSweeps,
};
// ==============================================================================
// END OF FILE
// ==============================================================================
