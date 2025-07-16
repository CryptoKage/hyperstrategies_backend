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

// --- Registration Endpoint ---
// This route is already correct and remains unchanged.
router.post('/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, username, referralCode } = req.body;
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }
    const emailCheck = await client.query('SELECT user_id FROM users WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }
    const usernameCheck = await client.query('SELECT user_id FROM users WHERE username = $1', [username]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'This username is already taken.' });
    }
    await client.query('BEGIN');
    let referrerId = null;
    if (referralCode) {
      const referrerResult = await client.query('SELECT user_id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrerResult.rows.length > 0) {
        referrerId = referrerResult.rows[0].user_id;
        console.log(`✅ Referrer found: ${referrerId}`);
      }
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const wallet = generateWallet();
    const encryptedKey = encrypt(wallet.privateKey);
    const newReferralCode = generateReferralCode();
    const newUser = await client.query(
      `INSERT INTO users (email, password_hash, username, eth_address, eth_private_key_encrypted, referral_code, referred_by_user_id, xp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 10)
       RETURNING user_id, email, username, eth_address`,
      [email, passwordHash, username, wallet.address, encryptedKey, newReferralCode, referrerId]
    );
    if (referrerId) {
      await client.query('UPDATE users SET xp = xp + 50 WHERE user_id = $1', [referrerId]);
      console.log(`✅ Awarded 50 XP to referrer ${referrerId}`);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'User created successfully', user: newUser.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration.' });
  } finally {
    client.release();
  }
});


// --- Login Endpoint ---
// This route is already correct and remains unchanged.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) { return res.status(401).json({ error: 'Invalid credentials.' }); }
    const result = await pool.query('SELECT user_id, username, email, password_hash, is_admin FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) { return res.status(401).json({ error: 'Invalid credentials.' }); }
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) { return res.status(401).json({ error: 'Invalid credentials.' }); }
    const payload = {
      user: {
        id: user.user_id,
        username: user.username,
        isAdmin: user.is_admin
      }
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// --- Google OAuth2 Routes ---
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// ✅ THIS IS THE UPDATED GOOGLE CALLBACK
router.get('/google/callback',
  passport.authenticate('google', {
    // Redirect to the frontend login page on failure
    failureRedirect: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/login` : 'http://localhost:3000/login'
  }),
  (req, res) => {
    // After Passport's logic runs, req.user is the full user object from our database
    // This includes the 'is_admin' flag because passport-setup.js fetches it.
    
    const payload = {
      user: {
        id: req.user.user_id,
        username: req.user.username,
        isAdmin: req.user.is_admin // We now include the admin status
      }
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

    // Redirect to the dedicated success page so the frontend can grab the token
    const frontend = process.env.FRONTEND_URL || 'https://www.hyper-strategies.com';
    res.redirect(`${frontend}/oauth-success?token=${token}`);
  }
);

// --- /me Route ---
// This route is correct and remains unchanged.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, eth_address FROM users WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) { return res.status(404).json({ error: 'User not found' }); }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in /me:', err.message);
    res.status(500).json({ error: 'Server error while fetching user profile' });
  }
});

module.exports = router;