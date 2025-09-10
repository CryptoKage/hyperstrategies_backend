// ==============================================================================
// START: PASTE THIS ENTIRE BLOCK into your new routes/bounties.js FILE
// ==============================================================================
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const fetch = require('node-fetch');
const { decrypt } = require('../utils/walletUtils');

// --- Helper function to call the X API ---
// We will build this out with more verification types in the future.
async function verifyBountyCompletion(user, bounty) {
  const accessToken = decrypt(user.x_access_token);
  
  // Use a switch statement to handle different bounty types
  switch (bounty.bounty_type) {
    case 'X_LIKE': {
      const url = `https://api.twitter.com/2/tweets/${bounty.target_id}/liking_users`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(`X API Error (Liking Users): ${JSON.stringify(data)}`);
      return data.data?.some(likingUser => likingUser.id === user.x_user_id) || false;
    }

    case 'X_RETWEET': {
      const url = `https://api.twitter.com/2/tweets/${bounty.target_id}/retweeted_by`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(`X API Error (Retweeted By): ${JSON.stringify(data)}`);
      return data.data?.some(retweetingUser => retweetingUser.id === user.x_user_id) || false;
    }

    case 'X_FOLLOW': {
      // For a follow, the bounty's target_id is the account they need to follow (e.g., your company's X ID)
      // The user.x_user_id is the person we are checking
      const url = `https://api.twitter.com/2/users/${user.x_user_id}/following`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(`X API Error (Following): ${JSON.stringify(data)}`);
      return data.data?.some(followedUser => followedUser.id === bounty.target_id) || false;
    }

    default:
      console.warn(`Unknown bounty type encountered: ${bounty.bounty_type}`);
      return false;
  }
}

// --- Endpoint 1: Get all active bounties ---
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bountiesResult = await pool.query("SELECT * FROM bounties WHERE is_active = TRUE ORDER BY bounty_id");
    res.json(bountiesResult.rows);
  } catch (error) {
    console.error("Error fetching active bounties:", error);
    res.status(500).json({ error: 'Failed to fetch bounties.' });
  }
});


// --- Endpoint 2: Verify a specific bounty for the logged-in user ---
router.post('/:bountyId/verify', authenticateToken, async (req, res) => {
  const { bountyId } = req.params;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get user and bounty details
    const userResult = await client.query('SELECT user_id, x_user_id, x_access_token FROM users WHERE user_id = $1', [userId]);
    const bountyResult = await client.query('SELECT * FROM bounties WHERE bounty_id = $1 AND is_active = TRUE', [bountyId]);

    if (userResult.rows.length === 0 || bountyResult.rows.length === 0) {
      throw new Error("User or bounty not found.");
    }
    const user = userResult.rows[0];
    const bounty = bountyResult.rows[0];

    // 2. Check if user is eligible (e.g., has their X account connected)
    if (bounty.bounty_type.startsWith('X_') && !user.x_user_id) {
      return res.status(400).json({ error: 'You must connect your X account to complete this bounty.' });
    }

    // 3. Check if the user has already been awarded this bounty
    const existingAward = await client.query(
      `SELECT activity_id FROM user_activity_log 
       WHERE user_id = $1 AND source = $2 AND description LIKE $3`,
      [userId, 'BOUNTY', `%Bounty #${bounty.bounty_id}:%`]
    );
    if (existingAward.rows.length > 0) {
      return res.status(409).json({ error: 'You have already completed this bounty.' });
    }

    // 4. Perform the actual verification against the external API (e.g., X)
    const isComplete = await verifyBountyCompletion(user, bounty);

    if (isComplete) {
      // 5. If complete, create an UNCLAIMED XP entry for the user
      const description = `Completed Bounty #${bounty.bounty_id}: ${bounty.title}`;
      await client.query(
        `INSERT INTO user_activity_log (user_id, activity_type, status, source, description, amount_primary, symbol_primary)
         VALUES ($1, 'XP_BOUNTY', 'UNCLAIMED', 'BOUNTY', $2, $3, 'XP')`,
        [userId, description, bounty.xp_reward]
      );
      
      await client.query('COMMIT');
      res.status(200).json({ success: true, message: 'Bounty verified! Your XP reward is now available to claim in the Rewards Center.' });

    } else {
      await client.query('ROLLBACK');
      res.status(200).json({ success: false, message: 'Bounty not yet completed. Please try again after completing the action.' });
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error verifying bounty ${bountyId} for user ${userId}:`, error);
    res.status(500).json({ error: 'An error occurred during verification.' });
  } finally {
    client.release();
  }
});

module.exports = router;
// ==============================================================================
// END OF FILE
// ==============================================================================
