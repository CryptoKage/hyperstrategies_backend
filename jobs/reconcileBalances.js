// jobs/reconcileBalances.js

const pool = require('../db');

const reconcileAllUserBalances = async () => {
  console.log('--- Starting Definitive User Balance Reconciliation Script (v2) ---');
  const client = await pool.connect();

  try {
    // 1. Get ALL users
    const { rows: allUsers } = await client.query("SELECT user_id, username, balance FROM users");
    console.log(`Found ${allUsers.length} total users to check.`);

    for (const user of allUsers) {
      await client.query('BEGIN');
      try {
        // 2. For each user, get their total lifetime deposits.
        const depositsResult = await client.query(
          "SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id = $1 AND token = 'usdc'",
          [user.user_id]
        );
        const totalDeposits = parseFloat(depositsResult.rows[0].total);

        // 3. Get the total capital they CURRENTLY have allocated in vaults.
        const allocatedResult = await client.query(
          "SELECT COALESCE(SUM(tradable_capital), 0) as total FROM user_vault_positions WHERE user_id = $1",
          [user.user_id]
        );
        const totalAllocated = parseFloat(allocatedResult.rows[0].total);
        
        // 4. Calculate the correct available balance.
        const correctBalance = totalDeposits - totalAllocated;
        const currentBalance = parseFloat(user.balance);

        console.log(`--- User: ${user.username} (${user.user_id}) ---`);
        console.log(`  (+) Total Deposits: ${totalDeposits}`);
        console.log(`  (-) Capital in Vaults: ${totalAllocated}`);
        console.log(`  ------------------------------------`);
        console.log(`  Current DB Balance:  ${currentBalance.toFixed(8)}`);
        console.log(`  Correct Balance Should Be: ${correctBalance.toFixed(8)}`);

        // 5. If the balance is incorrect, update it.
        if (Math.abs(currentBalance - correctBalance) > 0.000001) {
          console.log(`  >>> Balance is INCORRECT. Updating...`);
          await client.query(
            'UPDATE users SET balance = $1 WHERE user_id = $2',
            [correctBalance, user.user_id]
          );
        } else {
          console.log('  >>> Balance is correct.');
        }

        await client.query('COMMIT');
      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`Failed to process user ${user.user_id}:`, innerErr);
      }
    }

    console.log('--- Reconciliation Script Finished ---');

  } catch (error) {
    console.error('❌ Major error in reconciliation script:', error);
  } finally {
    if (client) client.release();
  }
};

reconcileAllUserBalances();