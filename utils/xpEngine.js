//: hyperstrategies_backend/utils/xpEngine.js

const pool = require('../db');

/**
 * A centralized engine for awarding XP and creating corresponding activity logs.
 * This is the single source of truth for all XP-related transactions.
 *
 * @param {object} options - The options for the XP award.
 * @param {string} options.userId - The UUID of the user to award XP to.
 * @param {number} options.xpAmount - The amount of XP to award.
 * @param {string} options.type - The type of XP award (e.g., 'DEPOSIT_BONUS', 'REFERRAL_BONUS').
 * @param {string} options.description - The descriptive text for the user's activity log.
 * @param {object} dbClient - An active database client, required for operating within a transaction.
 */
async function awardXp(options, dbClient) {
  const { userId, xpAmount, type, description } = options;

  if (!userId || !xpAmount || !type || !description || !dbClient) {
    throw new Error('awardXp requires userId, xpAmount, type, description, and a dbClient.');
  }

  // Round to avoid floating point issues
  const finalXpAmount = parseFloat(xpAmount.toFixed(8));

  if (finalXpAmount <= 0) {
    // Silently exit if there's no XP to award.
    return;
  }

  // 1. Add the XP to the user's main balance.
  await dbClient.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [finalXpAmount, userId]);

  // 2. Create a detailed entry in the activity log.
  // We use a consistent activity_type format of 'XP_...' for easy filtering.
  // All XP awarded by the engine is considered 'CLAIMED' as it's added directly.
  await dbClient.query(
    `INSERT INTO user_activity_log (user_id, activity_type, source, description, amount_primary, symbol_primary, status)
     VALUES ($1, $2, $3, $4, $5, 'XP', 'CLAIMED')`,
    [userId, `XP_${type}`, type, description, finalXpAmount]
  );
}

module.exports = { awardXp };
