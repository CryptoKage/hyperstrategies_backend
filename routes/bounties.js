// PASTE THIS TO REPLACE: hyperstrategies_backend/routes/bounties.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
// We no longer need fetch or decrypt here, as the verification is simpler

// This helper function can be removed or refactored later
async function verifyBountyCompletion(user, bounty) {
  switch (bounty.bounty_type) {
    case 'CONNECT_X': return !!user.x_user_id;
    case 'CONNECT_TELEGRAM': return !!user.telegram_id;
    default: return false;
  }
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    // Select the new key columns
    const bountiesResult = await pool.query("SELECT bounty_id, bounty_type, target_url, xp_reward, title_key, description_key FROM bounties WHERE is_active = TRUE ORDER BY bounty_id");
    res.json(bountiesResult.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bounties.' });
  }
});

router.post('/:bountyId/verify', authenticateToken, async (req, res) => {
  const { bountyId } = req.params;
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [userResult, bountyResult] = await Promise.all([
      client.query('SELECT user_id, x_user_id, telegram_id FROM users WHERE user_id = $1', [userId]),
      client.query('SELECT * FROM bounties WHERE bounty_id = $1 AND is_active = TRUE', [bountyId])
    ]);

    if (userResult.rows.length === 0 || bountyResult.rows.length === 0) throw new Error("User or bounty not found.");
    const user = userResult.rows[0];
    const bounty = bountyResult.rows[0];

    // Check if user has already been awarded this bounty
    const existingAward = await client.query(`SELECT activity_id FROM user_activity_log WHERE user_id = $1 AND source = $2 AND description LIKE $3`,[userId, 'BOUNTY', `%${bounty.title_key}%`]);
    if (existingAward.rows.length > 0) return res.status(409).json({ messageKey: 'bounties.error_already_completed' });

    const isComplete = await verifyBountyCompletion(user, bounty);

    if (isComplete) {
      // ==============================================================================
      // --- REFACTOR: Store a translatable JSON payload in the description ---
      // ==============================================================================
      const descriptionPayload = JSON.stringify({
          key: bounty.title_key // Use the title key as the description key
      });
      await client.query(
        `INSERT INTO user_activity_log (user_id, activity_type, status, source, description, amount_primary, symbol_primary)
         VALUES ($1, 'XP_BOUNTY', 'UNCLAIMED', 'BOUNTY', $2, $3, 'XP')`,
        [userId, descriptionPayload, bounty.xp_reward]
      );
      
      await client.query('COMMIT');
      res.status(200).json({ success: true, messageKey: 'bounties.success_verify' });
    } else {
      await client.query('ROLLBACK');
      res.status(200).json({ success: false, messageKey: 'bounties.error_not_complete' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ messageKey: 'bounties.error_unexpected' });
  } finally {
    client.release();
  }
});

module.exports = router;
