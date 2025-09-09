// START: PASTE THIS ENTIRE BLOCK into your new utils/pinUtils.js FILE

const pool = require('../db');
const { calculateActiveEffects } = require('./effectsEngine');

/**
 * Calculates a numerical score for a pin based on its effects.
 * Follows the priority: Deposit Fee > Performance Fee > XP Boost.
 * @param {object} pin - The pin object with its effects_config.
 * @returns {number} The calculated score.
 */
function getPinScore(pin) {
  const effects = pin.pin_effects_config || {};
  const depositDiscount = parseFloat(effects.deposit_fee_discount_pct) || 0;
  const perfDiscount = parseFloat(effects.performance_fee_discount_pct) || 0;
  const xpBoost = parseFloat(effects.xp_boost_pct) || 0;

  // Weights determine priority: 1000 for deposit, 100 for perf, 10 for xp.
  const score = (depositDiscount * 1000) + (perfDiscount * 100) + (xpBoost * 10);
  return score;
}

/**
 * Automatically equips the best possible set of pins for a user based on their
 * available slots and the calculated score of each pin they own.
 * @param {string} userId - The UUID of the user to update.
 * @param {object} dbClient - An active database client for transactions.
 */
async function autoEquipBestPins(userId, dbClient) {
  console.log(`[AutoEquip] Starting process for user ${userId}...`);
  try {
    // 1. Fetch ALL pins the user owns.
    const ownedPinsResult = await dbClient.query(`
      SELECT p.pin_id, p.pin_name, pd.pin_effects_config 
      FROM pins p
      JOIN pin_definitions pd ON p.pin_name = pd.pin_name
      WHERE p.owner_id = $1;
    `, [userId]);

    const ownedPins = ownedPinsResult.rows;
    if (ownedPins.length === 0) {
      console.log(`[AutoEquip] User ${userId} owns no pins. Nothing to do.`);
      return;
    }

    // 2. Score and sort all owned pins.
    ownedPins.sort((a, b) => {
      const scoreA = getPinScore(a);
      const scoreB = getPinScore(b);
      if (scoreB !== scoreA) {
        return scoreB - scoreA; // Higher score first
      }
      return a.pin_name.localeCompare(b.pin_name); // Alphabetical tie-breaker
    });

    // 3. Determine how many slots the user has available.
    // We pass the dbClient to ensure we're in the same transaction.
    const effects = await calculateActiveEffects(userId, dbClient);
    const availableSlots = effects.total_pin_slots;
    
    console.log(`[AutoEquip] User ${userId} has ${availableSlots} slots. Best pin is '${ownedPins[0].pin_name}' with score ${getPinScore(ownedPins[0])}.`);

    // 4. Select the top N pins, where N is the number of available slots.
    const bestPinsToEquip = ownedPins.slice(0, availableSlots);
    const bestPinIds = bestPinsToEquip.map(p => p.pin_id);

    // 5. Update the user's active loadout in the database.
    // First, clear their current loadout.
    await dbClient.query('DELETE FROM user_active_pins WHERE user_id = $1', [userId]);

    // Then, insert the new, optimized loadout.
    if (bestPinIds.length > 0) {
      const insertValues = bestPinIds.map((pinId, index) => `('${userId}', ${pinId}, ${index + 1})`).join(',');
      const insertQuery = `INSERT INTO user_active_pins (user_id, pin_id, slot_number) VALUES ${insertValues}`;
      await dbClient.query(insertQuery);
    }
    
    console.log(`[AutoEquip] Successfully equipped ${bestPinsToEquip.length} best pins for user ${userId}.`);

  } catch (error) {
    // We throw the error so the calling function's transaction will roll back.
    console.error(`[AutoEquip] FAILED for user ${userId}. Error:`, error.message);
    throw error;
  }
}

module.exports = { autoEquipBestPins };
