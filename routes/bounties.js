// FILE: cryptokage-hyperstrategies_backend/routes/bounties.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { awardXp } = require('../utils/xpEngine'); // We will use the xpEngine for consistency
const { calculateUserTier } = require('../utils/tierUtils');

async function verifyBountyCompletion(user, bounty, dbClient) {
  switch (bounty.bounty_type) {
    case 'CONNECT_X':
      return !!user.x_user_id;

    case 'CONNECT_TELEGRAM':
      return !!user.telegram_id;

    case 'DEPOSIT_IN_VAULT': {
      const vaultId = bounty.target_id;
      if (!vaultId) return false;
      const res = await dbClient.query(
        `SELECT 1 FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND entry_type IN ('DEPOSIT', 'VAULT_TRANSFER_IN') LIMIT 1`,
        [user.user_id, vaultId]
      );
      return res.rows.length > 0;
    }
      
    case 'STAKE_FOR_DURATION': {
      const vaultId = bounty.target_id;
      if (!vaultId) return false;
      const res = await dbClient.query(
        `SELECT MIN(created_at) as first_deposit_date FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND entry_type IN ('DEPOSIT', 'VAULT_TRANSFER_IN')`,
        [user.user_id, vaultId]
      );
      if (!res.rows[0].first_deposit_date) return false;

      const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
      const firstDepositTime = new Date(res.rows[0].first_deposit_date).getTime();
      return (Date.now() - firstDepositTime) > thirtyDaysInMs;
    }

    case 'RECEIVE_BUYBACK': {
      const res = await dbClient.query(
        `SELECT 1 FROM user_activity_log WHERE user_id = $1 AND activity_type = 'BONUS_POINT_BUYBACK' LIMIT 1`,
        [user.user_id]
      );
      return res.rows.length > 0;
    }

    default:
      return false;
  }
}

// GET endpoint to fetch available bounties for the current user
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // This query now fetches all active bounties AND excludes those the user has already completed.
    const query = `
      SELECT b.bounty_id, b.bounty_type, b.target_id, b.target_url, b.xp_reward, b.title_key, b.description_key
      FROM bounties b
      WHERE b.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM user_activity_log ual
        WHERE ual.user_id = $1
        AND ual.source = 'BOUNTY'
        AND ual.description LIKE '%' || b.title_key || '%'
      )
      ORDER BY b.bounty_id;
    `;
    const bountiesResult = await pool.query(query, [userId]);
    res.json(bountiesResult.rows);
  } catch (error) {
    console.error("Error fetching available bounties:", error);
    res.status(500).json({ error: 'Failed to fetch bounties.' });
  }
});

// POST endpoint to verify and automatically credit a bounty
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

    if (userResult.rows.length === 0 || bountyResult.rows.length === 0) {
      throw new Error("User or bounty not found.");
    }
    const user = userResult.rows[0];
    const bounty = bountyResult.rows[0];
    
    // Double-check if already completed, in case of a race condition.
    const existingAward = await client.query(`SELECT 1 FROM user_activity_log WHERE user_id = $1 AND source = 'BOUNTY' AND description LIKE $2`,[userId, `%${bounty.title_key}%`]);
    if (existingAward.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ messageKey: 'bounties.error_already_completed' });
    }

    const isComplete = await verifyBountyCompletion(user, bounty, client);

    if (isComplete) {
      // --- NEW: Automatic Crediting Logic ---
      // 1. Use the xpEngine to award XP and create the 'COMPLETED' log entry.
      await awardXp({
        userId: userId,
        xpAmount: bounty.xp_reward,
        type: 'BOUNTY',
        descriptionKey: bounty.title_key,
        // No vars needed if we just use the title key
      }, client);

      // 2. Re-calculate and update the user's tier.
      const updatedUserResult = await client.query('SELECT xp FROM users WHERE user_id = $1', [userId]);
      const newTotalXp = parseFloat(updatedUserResult.rows[0].xp);
      const newTier = calculateUserTier(newTotalXp);
      await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newTier, userId]);
      
      await client.query('COMMIT');
      res.status(200).json({ success: true, messageKey: 'bounties.success_credited' }); // New success key
    } else {
      await client.query('ROLLBACK');
      res.status(200).json({ success: false, messageKey: 'bounties.error_not_complete' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Bounty verification error for bounty ${bountyId}:`, error);
    res.status(500).json({ messageKey: 'bounties.error_unexpected' });
  } finally {
    client.release();
  }
});

module.exports = router;
