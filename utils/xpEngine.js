// PASTE THIS TO REPLACE: hyperstrategies_backend/utils/xpEngine.js

const pool = require('../db');

/**
 * A centralized engine for awarding XP and creating corresponding activity logs.
 * This is the single source of truth for all XP-related transactions.
 *
 * @param {object} options - The options for the XP award.
 * @param {string} options.userId - The UUID of the user to award XP to.
 * @param {number} options.xpAmount - The amount of XP to award.
 * @param {string} options.type - The type of XP award (e.g., 'DEPOSIT_BONUS').
 * @param {string} options.descriptionKey - The translation key for the description.
 * @param {object} [options.descriptionVars] - Optional variables for the translation.
 * @param {object} dbClient - An active database client.
 */
async function awardXp(options, dbClient) {
  const { userId, xpAmount, type, descriptionKey, descriptionVars, relatedVaultId } = options;

  if (!userId || !xpAmount || !type || !descriptionKey || !dbClient) {
    throw new Error('awardXp requires userId, xpAmount, type, descriptionKey, and a dbClient.');
  }

  const finalXpAmount = parseFloat(xpAmount.toFixed(8));
  if (finalXpAmount <= 0) return;

  await dbClient.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [finalXpAmount, userId]);

  const descriptionPayload = JSON.stringify({ key: descriptionKey, vars: descriptionVars || {} });

  // --- THIS IS THE FIX: We now correctly save the related_vault_id ---
  await dbClient.query(
    `INSERT INTO user_activity_log (user_id, activity_type, source, description, amount_primary, symbol_primary, status, related_vault_id)
     VALUES ($1, $2, $3, $4, $5, 'XP', 'COMPLETED', $6)`, // Changed status to COMPLETED for direct awards
    [userId, `XP_${type}`, type, descriptionPayload, finalXpAmount, relatedVaultId || null]
  );
}

module.exports = { awardXp };
