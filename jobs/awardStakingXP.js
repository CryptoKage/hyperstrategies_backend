// jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');

/**
 * A job that runs periodically (e.g., daily) to award XP for time-weighted capital
 * and update user account tiers accordingly.
 */
const processTimeWeightedRewards = async () => {
  console.log(' Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    const { rows: positions } = await client.query(`
      SELECT
        p.user_id,
        p.tradable_capital,
        u.xp as current_xp,
        u.account_tier as current_tier
      FROM
        user_vault_positions p
      JOIN
        users u ON p.user_id = u.user_id
      WHERE
        p.status = 'in_trade';
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process for staking rewards.');
      client.release(); // Release client and exit if no work to do
      return;
    }

    console.log(`Found ${positions.length} active positions to process.`);

    for (const position of positions) {
      // We wrap each user's update in its own transaction.
      // This ensures that if one user fails, it doesn't stop the whole job.
      await client.query('BEGIN');
      try {
        const capital = parseFloat(position.tradable_capital);
        
        // This calculation can result in a decimal value.
        const dailyXpAwardDecimal = capital / 300;

        // --- THE FIX ---
        // We round the awarded XP DOWN to the nearest whole number to match the database 'xp' column type.
        const dailyXpAwardInteger = Math.floor(dailyXpAwardDecimal);

        // If the daily award rounds down to 0, there's nothing to do for this user today.
        if (dailyXpAwardInteger <= 0) {
          await client.query('COMMIT'); // Commit the empty transaction and move to the next user.
          continue;
        }
        
        // We use parseInt on the current XP to ensure we are doing integer arithmetic.
        const newTotalXp = parseInt(position.current_xp, 10) + dailyXpAwardInteger;
        const newCalculatedTier = calculateUserTier(newTotalXp);

        // This query will now receive a whole number (integer) and succeed.
        await client.query(
          'UPDATE users SET xp = $1 WHERE user_id = $2',
          [newTotalXp, position.user_id]
        );

        // Check if the user's tier has changed and update if necessary.
        if (newCalculatedTier !== position.current_tier) {
          await client.query(
            'UPDATE users SET account_tier = $1 WHERE user_id = $2',
            [newCalculatedTier, position.user_id]
          );
          console.log(`User ${position.user_id} has leveled up to Tier ${newCalculatedTier}!`);
        }

        // Log this transaction for the user's history.
        const description = `Earned ${dailyXpAwardInteger} XP for time-staked capital.`;
        await client.query(
          `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
           VALUES ($1, 'XP_STAKING_BONUS', $2, $3, 'XP', 'COMPLETED')`,
          [position.user_id, description, dailyXpAwardInteger]
        );
        
        await client.query('COMMIT'); // Commit the successful transaction for this user.
      } catch (innerErr) {
        await client.query('ROLLBACK'); // If anything fails for this user, roll back their changes.
        console.error(`Error processing position for user ${position.user_id}. Rolling back transaction for this user.`, innerErr);
        // The loop will then continue to the next user.
      }
    }

    console.log('✅ Daily time-weighted reward processing complete.');

  } catch (error) {
    // This catches errors in the main part of the function, like failing to connect or get positions.
    console.error('❌ Major error in processTimeWeightedRewards job:', error);
  } finally {
    // This ensures the database client is always released, no matter what happens.
    if (client) {
      client.release();
    }
  }
};

module.exports = {
  processTimeWeightedRewards,
};