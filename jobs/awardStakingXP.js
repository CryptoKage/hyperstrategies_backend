// jobs/awardStakingXP.js

const pool = require('../db');
const { calculateUserTier } = require('../utils/tierUtils');

const processTimeWeightedRewards = async () => {
  console.log(' Kicking off daily time-weighted reward processing...');
  const client = await pool.connect();
  try {
    const { rows: positions } = await client.query(`
      SELECT p.user_id, p.tradable_capital, u.xp as current_xp, u.account_tier as current_tier
      FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
      WHERE p.status IN ('in_trade', 'active');
    `);

    if (positions.length === 0) {
      console.log('No active vault positions to process.');
      client.release();
      return;
    }

    console.log(`Found ${positions.length} active positions to process.`);

    for (const position of positions) {
      await client.query('BEGIN');
      try {
        const capital = parseFloat(position.tradable_capital);
        
        // --- THE FIX ---
        // We no longer round the XP down. We keep the decimal value.
        const dailyXpAward = capital / 300; 

        if (dailyXpAward <= 0) {
          await client.query('COMMIT');
          continue;
        }
        
        const newTotalXp = parseFloat(position.current_xp) + dailyXpAward;
        // The calculateUserTier function will correctly handle the decimal XP value.
        const newCalculatedTier = calculateUserTier(newTotalXp);

        await client.query(
          'UPDATE users SET xp = $1 WHERE user_id = $2',
          [newTotalXp, position.user_id] // Save the new decimal XP value
        );

        if (newCalculatedTier !== position.current_tier) {
          await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newCalculatedTier, position.user_id]);
          console.log(`User ${position.user_id} has leveled up to Tier ${newCalculatedTier}!`);
        }

        const description = `Earned ${dailyXpAward.toFixed(4)} XP for time-staked capital.`;
        await client.query(
          `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
           VALUES ($1, 'XP_STAKING_BONUS', $2, $3, 'XP', 'COMPLETED')`,
          [position.user_id, description, dailyXpAward]
        );
        
        await client.query('COMMIT');
      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`Error processing position for user ${position.user_id}. Rolling back.`, innerErr);
      }
    }

    console.log('✅ Daily time-weighted reward processing complete.');

  } catch (error) {
    console.error('❌ Major error in processTimeWeightedRewards job:', error);
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  processTimeWeightedRewards,
};