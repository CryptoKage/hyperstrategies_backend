// FILE: cryptokage-hyperstrategies_backend/jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');
const { calculateActiveEffects } = require('../utils/effectsEngine');
const { awardXp } = require('../utils/xpEngine');

const processTimeWeightedRewards = async () => {
  console.log('Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    const { rows: positions } = await client.query(`
      SELECT p.user_id, p.tradable_capital, p.vault_id
      FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
      WHERE p.status IN ('in_trade', 'active');
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process.');
      // Ensure the client is released even if there's no work.
      client.release(); 
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

    // A map to hold XP gains per user, per vault.
    const userVaultXpGains = new Map();

    for (const position of positions) {
      const capital = parseFloat(position.tradable_capital);
      // The base rate is 1 XP per $300 of capital per day.
      const baseDailyXpAward = capital / 300; 
      if (baseDailyXpAward <= 0) continue;
      
      const userEffects = userEffectsMap.get(position.user_id);
      const xpBoostPercentage = userEffects.xp_boost_pct || 0;
      
      const finalDailyXpAward = baseDailyXpAward * (1 + (xpBoostPercentage / 100));
      
      // Store the gain associated with the specific vault.
      const key = `${position.user_id}-${position.vault_id}`;
      const currentGain = userVaultXpGains.get(key) || 0;
      userVaultXpGains.set(key, currentGain + finalDailyXpAward);
    }

    await client.query('BEGIN');

    // Loop through the per-vault gains to create specific log entries.
    for (const [key, xp_gain] of userVaultXpGains.entries()) {
      const [userId, vaultId] = key.split('-');
      
      // Update the user's total XP.
      await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xp_gain, userId]);

      // Call the xpEngine to create the activity log.
      // THIS IS THE CRITICAL FIX: The 'client' object is passed as the second argument.
      await awardXp({
        userId: userId,
        xpAmount: xp_gain,
        type: 'STAKING_BONUS',
        descriptionKey: 'xp_history.staking_bonus',
        descriptionVars: { amount: xp_gain.toFixed(4), vaultId: vaultId },
        relatedVaultId: vaultId // Pass vaultId for specific logging
      }, client);
    }
    
    // After all XP has been awarded, loop through affected users to update their tier.
    const updatedUserIds = [...new Set(Array.from(userVaultXpGains.keys()).map(key => key.split('-')[0]))];

    for (const userId of updatedUserIds) {
        const userResult = await client.query('SELECT xp FROM users WHERE user_id = $1', [userId]);
        const newTotalXp = parseFloat(userResult.rows[0].xp);
        const newCalculatedTier = calculateUserTier(newTotalXp);
        await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newCalculatedTier, userId]);
    }
    
    await client.query('COMMIT');
    console.log(`✅ Daily reward processing complete. Updated ${updatedUserIds.length} users.`);

  } catch (error) {
    // Ensure rollback on any error
    if(client) await client.query('ROLLBACK').catch(console.error);
    console.error('❌ Major error in processTimeWeightedRewards job:', error);
  } finally {
    // Ensure the client is always released back to the pool
    if (client) client.release();
  }
};

module.exports = { processTimeWeightedRewards };
