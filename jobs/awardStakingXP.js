// hyperstrategies_backend/jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');
const { calculateActiveEffects } = require('../utils/effectsEngine');
const { awardXp } = require('../utils/xpEngine');

const processTimeWeightedRewards = async () => {
  console.log('Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    const { rows: positions } = await client.query(`
      SELECT p.user_id, p.tradable_capital
      FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
      WHERE p.status IN ('in_trade', 'active');
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process.');
      return;
    }
    console.log(`Found ${positions.length} active positions to process.`);

    const userUpdates = new Map();
    const allUserIds = [...new Set(positions.map(p => p.user_id))];
    const userEffectsMap = new Map();
    for (const userId of allUserIds) {
      try {
        const effects = await calculateActiveEffects(userId, client);
        userEffectsMap.set(userId, effects);
      } catch (effectError) {
        console.error(`Could not fetch effects for user ${userId}, skipping boosts. Error:`, effectError.message);
        userEffectsMap.set(userId, { xp_boost_pct: 0 });
      }
    }

    for (const position of positions) {
      const capital = parseFloat(position.tradable_capital);
      const baseDailyXpAward = capital / 300;
      if (baseDailyXpAward <= 0) continue;
      
      const userEffects = userEffectsMap.get(position.user_id);
      const xpBoostPercentage = userEffects.xp_boost_pct || 0;
      
      const finalDailyXpAward = baseDailyXpAward * (1 + (xpBoostPercentage / 100));
      const currentGain = userUpdates.get(position.user_id) || 0;
      userUpdates.set(position.user_id, currentGain + finalDailyXpAward);
    }

    await client.query('BEGIN');
    for (const [userId, total_xp_gain] of userUpdates.entries()) {
      await awardXp({
        userId: userId,
        xpAmount: total_xp_gain,
        type: 'STAKING_BONUS',
        descriptionKey: 'xp_history.staking_bonus',
        descriptionVars: { amount: total_xp_gain.toFixed(4) }
      }, client);
      
      const userResult = await client.query('SELECT xp FROM users WHERE user_id = $1', [userId]);
      const newTotalXp = parseFloat(userResult.rows[0].xp);
      const newCalculatedTier = calculateUserTier(newTotalXp);
      await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newCalculatedTier, userId]);
    }
    await client.query('COMMIT');
    console.log(`✅ Daily reward processing complete. Updated ${userUpdates.size} users.`);

  } catch (error) {
    if(client) await client.query('ROLLBACK').catch(console.error);
    console.error('❌ Major error in processTimeWeightedRewards job:', error);
  } finally {
    if (client) client.release();
  }
};

module.exports = { processTimeWeightedRewards };
