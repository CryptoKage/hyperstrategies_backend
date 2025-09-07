// jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');
const { calculateActiveEffects } = require('../utils/effectsEngine');

const processTimeWeightedRewards = async () => {
  console.log('Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    const { rows: positions } = await client.query(`
      SELECT p.user_id, p.tradable_capital, u.xp as current_xp
      FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
      WHERE p.status IN ('in_trade', 'active');
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process.');
      return;
    }
    console.log(`Found ${positions.length} active positions to process.`);

    const userUpdates = new Map();

    // --- STEP 2: Fetch effects for ALL users first (more efficient) ---
    const allUserIds = [...new Set(positions.map(p => p.user_id))];
    const userEffectsMap = new Map();
    for (const userId of allUserIds) {
      try {
        const effects = await calculateActiveEffects(userId, client);
        userEffectsMap.set(userId, effects);
      } catch (effectError) {
        console.error(`Could not fetch effects for user ${userId}, skipping boosts. Error:`, effectError.message);
        // Default to no effects if there's an error
        userEffectsMap.set(userId, { xp_boost_pct: 0 });
      }
    }

    // --- STEP 3: Apply boosts during XP calculation ---
    for (const position of positions) {
      const capital = parseFloat(position.tradable_capital);
      const baseDailyXpAward = capital / 300; // The base XP rate
      if (baseDailyXpAward <= 0) continue;
      
      const userEffects = userEffectsMap.get(position.user_id);
      const xpBoostPercentage = userEffects.xp_boost_pct || 0;
      
      // Calculate the final XP award with the boost
      const finalDailyXpAward = baseDailyXpAward * (1 + (xpBoostPercentage / 100));

      const currentUpdate = userUpdates.get(position.user_id) || {
        current_xp: parseFloat(position.current_xp),
        total_xp_gain: 0
      };
      
      currentUpdate.total_xp_gain += finalDailyXpAward;
      userUpdates.set(position.user_id, currentUpdate);
    }

    await client.query('BEGIN');
    try {
      for (const [userId, update] of userUpdates.entries()) {
        const newTotalXp = update.current_xp + update.total_xp_gain;
        const currentTier = calculateUserTier(update.current_xp);
        const newCalculatedTier = calculateUserTier(newTotalXp);

        await client.query('UPDATE users SET xp = $1, account_tier = $2 WHERE user_id = $3', [newTotalXp, newCalculatedTier, userId]);
        if (newCalculatedTier !== currentTier) {
          console.log(`User ${userId} has leveled up to Tier ${newCalculatedTier}!`);
        }

        const description = `Earned ${update.total_xp_gain.toFixed(4)} XP from daily staking rewards.`;
        await client.query(
          `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
           VALUES ($1, 'XP_STAKING_BONUS', $2, $3, 'XP', 'COMPLETED')`,
          [userId, description, update.total_xp_gain]
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

module.exports = {  processTimeWeightedRewards,};
