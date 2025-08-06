// server/routes/auth.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const passport = require('passport');
const { generateWallet, encrypt } = require('../utils/walletUtils');
const authenticateToken = require('../middleware/authenticateToken');

function generateReferralCode() {
  return 'HS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// --- Registration Endpoint (DEFINITIVE V3 - Matches DDL) ---
router.post('/register', async (req, res) => {
  const { email, password, username, referralCode } = req.body;
  
  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Username, email, and password are required.' });
  }

  const client = await pool.connect();
  try {
    const emailCheck = await client.query('SELECT user_id FROM users WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }
    const usernameCheck = await client.query('SELECT user_id FROM users WHERE username = $1', [username]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'This username is already taken.' });
    }

    await client.query('BEGIN');
    
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const userCountResult = await client.query('SELECT COUNT(*) FROM users');
    const currentUserCount = parseInt(userCountResult.rows[0].count);
    
    let xpToAward = 0;
    if (currentUserCount < 100) xpToAward = 25;
    else if (currentUserCount < 200) xpToAward = 20;
    else if (currentUserCount < 300) xpToAward = 15;
    else if (currentUserCount < 400) xpToAward = 10;
    else if (currentUserCount < 500) xpToAward = 5;

    let referrerId = null;
    if (referralCode) {
      const referrerResult = await client.query('SELECT user_id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrerResult.rows.length > 0) {
        referrerId = referrerResult.rows[0].user_id;
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const wallet = generateWallet();
    const encryptedKey = encrypt(wallet.privateKey);
    const newReferralCode = generateReferralCode();

    // --- NEW TAGS LOGIC ---
  const initialTags = [];
const lowerCaseRefCode = referralCode ? referralCode.toLowerCase() : '';

if (lowerCaseRefCode === 'hs-hip-hop') {
  initialTags.push('hip_hop_syndicate');
} else if (lowerCaseRefCode === 'hs-shadwmf') { // Inventing a code for ShadwMF
  initialTags.push('shadwmf_syndicate');
} else if (lowerCaseRefCode === 'hs-purrtardos') { // Inventing a code for Purrtardos
  initialTags.push('purrtardos_syndicate');
    }

    // --- UPDATED INSERT STATEMENT ---
    const newUserQuery = `
      INSERT INTO users (
        email, password_hash, username, google_id, balance, 
        eth_address, eth_private_key_encrypted, referred_by_user_id, 
        xp, bio, theme, referral_code, is_admin, account_tier,
        tags -- FIX 1: Add the new column
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) -- FIX 2: Add the new placeholder
      RETURNING user_id, email, username, eth_address`;
      
    const newUserParams = [
      email,                  // $1
      passwordHash,           // $2
      username,               // $3
      null,                   // $4: google_id
      0.00,                   // $5: balance
      wallet.address,         // $6: eth_address
      encryptedKey,           // $7: eth_private_key_encrypted
      referrerId,             // $8: referred_by_user_id
      xpToAward,              // $9: xp
      null,                   // $10: bio
      'dark',                 // $11: theme
      newReferralCode,        // $12: referral_code
      false,                  // $13: is_admin
      1,                      // $14: account_tier
      initialTags             // $15: FIX 3: Add the initial tags array
    ];
    
    const newUser = await client.query(newUserQuery, newUserParams);

    await client.query('COMMIT');
    res.status(201).json({ message: 'User created successfully', user: newUser.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('REGISTRATION PROCESS FAILED:', error); 
    res.status(500).json({ error: 'Server error during registration.' });
  } finally {
    client.release();
  }
});

// --- Standard Login ---
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(`[Login Attempt] for email: ${email}`);

    if (!email || !password) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    
    const result = await pool.query('SELECT user_id, username, email, password_hash, is_admin FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      console.log(`[Login Failed] No user found for email: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    
    const user = result.rows[0];
    
    console.log(`[Login Attempt] User found. Comparing password for user ID: ${user.user_id}`);
    const isMatch = await bcrypt.compare(password, user.password_hash);
    console.log(`[Login Attempt] Password match result: ${isMatch}`);
    
    if (!isMatch) {
      console.log(`[Login Failed] Password mismatch for user ID: ${user.user_id}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    
    const payload = { user: { id: user.user_id, username: user.username, isAdmin: user.is_admin } };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    
    console.log(`[Login Success] JWT generated for user ID: ${user.user_id}`);
    res.json({ token });

  } catch (error) {
    console.error('[Login Error]', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// --- Google OAuth2 ---
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));


router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: process.env.FRONTEND_URL || 'https://www.hyper-strategies.com/login' }),
  async (req, res) => {
    try {
      // Ensure Google users have a referral code
      if (!req.user.referral_code) {
        const newCode = generateReferralCode();
        await pool.query('UPDATE users SET referral_code = $1 WHERE user_id = $2', [newCode, req.user.user_id]);
      }

      const payload = { user: { id: req.user.user_id, username: req.user.username, isAdmin: req.user.is_admin } };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      const frontend = process.env.FRONTEND_URL || 'https://www.hyper-strategies.com';
      res.redirect(`${frontend}/oauth-success?token=${token}`);
    } catch (err) {
      console.error('Google callback error:', err);
      res.redirect(`${process.env.FRONTEND_URL || 'https://www.hyper-strategies.com'}/login`);
    }
  }
);

// --- /me Route ---
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, eth_address FROM users WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in /me:', err.message);
    res.status(500).json({ error: 'Server error while fetching user profile' });
  }
});

module.exports = router;