// jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');

const processTimeWeightedRewards = async () => {
  console.log('Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    // --- OPTIMIZATION 1: Fetch all necessary data in a single, clean query ---
    const { rows: positions } = await client.query(`
      SELECT p.user_id, p.tradable_capital, u.xp as current_xp
      FROM user_vault_positions p
      JOIN users u ON p.user_id = u.user_id
      WHERE p.status IN ('in_trade', 'active');
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process.');
      return; // No need to hold the client open
    }

    console.log(`Found ${positions.length} active positions to process.`);

    // --- OPTIMIZATION 2: Calculate all awards in memory first ---
    const userUpdates = new Map();
    const activityLogInserts = [];

    for (const position of positions) {
      const capital = parseFloat(position.tradable_capital);
      const dailyXpAward = capital / 300;

      if (dailyXpAward <= 0) {
        continue;
      }

      // Aggregate XP for users with multiple positions
      const currentUpdate = userUpdates.get(position.user_id) || {
        current_xp: parseFloat(position.current_xp),
        total_xp_gain: 0,
      };
      
      currentUpdate.total_xp_gain += dailyXpAward;
      userUpdates.set(position.user_id, currentUpdate);
    }

    // --- OPTIMIZATION 3: Perform all database writes in a single transaction ---
    await client.query('BEGIN');
    try {
      for (const [userId, update] of userUpdates.entries()) {
        const newTotalXp = update.current_xp + update.total_xp_gain;
        const currentTier = calculateUserTier(update.current_xp);
        const newCalculatedTier = calculateUserTier(newTotalXp);

        // Update the user's XP and potentially their tier
        await client.query(
          'UPDATE users SET xp = $1, account_tier = $2 WHERE user_id = $3',
          [newTotalXp, newCalculatedTier, userId]
        );

        if (newCalculatedTier !== currentTier) {
          console.log(`User ${userId} has leveled up to Tier ${newCalculatedTier}!`);
        }
        
        // Prepare the activity log entry for bulk insertion
        const description = `Earned ${update.total_xp_gain.toFixed(4)} XP from daily staking rewards.`;
        activityLogInserts.push({
          user_id: userId,
          activity_type: 'XP_STAKING_BONUS',
          description,
          amount: update.total_xp_gain
        });
      }

      // --- OPTIMIZATION 4: Use a single INSERT for all activity logs ---
      // This is vastly more efficient than one INSERT per user.
      if (activityLogInserts.length > 0) {
        const queryValues = activityLogInserts.map(
          log => `(${log.user_id}, '${log.activity_type}', '${log.description.replace(/'/g, "''")}', ${log.amount}, 'XP', 'COMPLETED')`
        ).join(',');
        
        await client.query(
          `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ${queryValues}`
        );
      }

      await client.query('COMMIT');
      console.log(`✅ Daily reward processing complete. Updated ${userUpdates.size} users.`);

    } catch (dbError) {
      await client.query('ROLLBACK');
      console.error('Database error during bulk update. Rolling back.', dbError);
    }

  } catch (error) {
    console.error('❌ Major error in processTimeWeightedRewards job:', error);
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  processTimeWeightedRewards,
};