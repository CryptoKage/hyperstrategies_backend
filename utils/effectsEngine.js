// utils/effectsEngine.js 
const pool = require('../db');

/**
 * A centralized engine to calculate a user's total active effects from their tier and equipped pins.
 * @param {string} userId - The UUID of the user.
 * @param {object} [dbClient=pool] - An existing database client, if operating within a transaction.
 * @returns {Promise<object>} A promise that resolves to an object containing the user's final calculated effects.
 */
async function calculateActiveEffects(userId, dbClient = pool) {
  // 1. Define the default state for a user with no bonuses.
  const finalEffects = {
    fee_discount_pct: 0,    
    xp_boost_pct: 0,
    extra_pin_slots: 0,
    // Add any new effect types here in the future
  };

  // 2. Fetch the user's base account tier and all their equipped pins in one efficient query.
  const userQuery = 'SELECT account_tier FROM users WHERE user_id = $1';
  const pinsQuery = `
    SELECT pd.pin_effects_config 
    FROM pin_definitions pd
    WHERE pd.pin_name IN (
        SELECT p.pin_name 
        FROM pins p
        WHERE p.pin_id IN (
            SELECT uap.pin_id 
            FROM user_active_pins uap 
            WHERE uap.user_id = $1
        )
    ) AND pd.pin_effects_config IS NOT NULL;
  `;

  const [userResult, activePinsResult] = await Promise.all([
    dbClient.query(userQuery, [userId]),
    dbClient.query(pinsQuery, [userId])
  ]);

  if (userResult.rows.length === 0) {
    throw new Error(`User not found with ID: ${userId}`);
  }

  const user = userResult.rows[0];
  const activePins = activePinsResult.rows;

  // 3. Loop through the equipped pins and aggregate their effects.
  for (const pin of activePins) {
    const effects = pin.pin_effects_config;

    if (effects.deposit_fee_discount_pct) {
      finalEffects.fee_discount_pct += parseFloat(effects.deposit_fee_discount_pct) || 0;
    }
    if (effects.xp_boost_pct) {
      finalEffects.xp_boost_pct += parseFloat(effects.xp_boost_pct) || 0;
    }
    if (effects.extra_pin_slots) {
      finalEffects.extra_pin_slots += parseInt(effects.extra_pin_slots, 10) || 0;
    }
  }

  // 4. Calculate the user's total available pin slots.
  // This is their base tier plus any bonus slots from equipped pins.
  finalEffects.total_pin_slots = (user.account_tier || 1) + finalEffects.extra_pin_slots;

  return finalEffects;
}

module.exports = { calculateActiveEffects };
