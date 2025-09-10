// ==============================================================================
// START: PASTE THIS ENTIRE BLOCK into your new routes/authX.js FILE
// ==============================================================================
const express = require('express');
const fetch = require('node-fetch');
const pool = require('../db');
const { encrypt } = require('../utils/walletUtils');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// All routes in this file require a user to be logged in first.
router.use(authenticateToken);

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const { code_verifier } = req.session; // We will use session storage
  const { id: userId } = req.user;

  // 1. Validate that we received a code and have a verifier
  if (!code) {
    return res.status(400).send('Error: Authorization code is missing from X callback.');
  }
  if (!code_verifier) {
    return res.status(400).send('Error: Code verifier is missing from session. Please try connecting again.');
  }

  const client = await pool.connect();
  try {
    // 2. Exchange the authorization code for an access token
    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.X_CLIENT_ID,
      redirect_uri: process.env.X_CALLBACK_URL, // Use the one from your .env
      code_verifier: code_verifier,
      code: code
    });



     const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
    
    const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}` // <-- This header was missing
      },
      body: tokenRequestBody
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) { throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`); }


    // 3. Use the new access token to fetch the user's X profile
    const meResponse = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const meData = await meResponse.json();
    if (!meResponse.ok) {
        throw new Error(`Failed to get user profile from X: ${JSON.stringify(meData)}`);
    }

    const xUserId = meData.data.id;
    
    // 4. Save the new X account info and tokens to the database
    // We use a transaction to ensure all writes succeed or fail together.
    await client.query('BEGIN');
    
    // Check if another user has already linked this X account
    const existingLink = await client.query('SELECT user_id FROM users WHERE x_user_id = $1 AND user_id != $2', [xUserId, userId]);
    if (existingLink.rows.length > 0) {
        throw new Error('This X account is already linked to another platform user.');
    }

    // Update the users table with the new X ID
    await client.query(
      'UPDATE users SET x_user_id = $1, x_access_token = $2, x_refresh_token = $3 WHERE user_id = $4',
      [
        xUserId,
        encrypt(tokenData.access_token),
        tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        userId
      ]
    );

    await client.query('COMMIT');
    
    // Clear the verifier from the session
    delete req.session.code_verifier;

    // 5. Redirect the user back to their profile page on success
    res.redirect(`${process.env.FRONTEND_URL}/profile`);

  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('[X OAuth Callback Error]:', error);
    // Redirect to profile with an error message
    res.redirect(`${process.env.FRONTEND_URL}/profile?error=x_connection_failed`);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
// ==============================================================================
// END OF FILE
// ==============================================================================
