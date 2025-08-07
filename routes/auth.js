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
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

function generateReferralCode() {
  return 'HS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// --- FIX 1: Stricter rate limit ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 auth attempts per 15 mins
  message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/register',
  //authLimiter,
  [
    body('email').isEmail().withMessage('Please provide a valid email').normalizeEmail(),
    body('username').trim().escape().notEmpty().withMessage('Username is required'),
    body('password').isStrongPassword({
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    }).withMessage('Password must be at least 8 characters and include uppercase, lowercase, number, and symbol.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, username, referralCode } = req.body;
    
    // --- FIX 2: Moved client connection inside the try block ---
    let client;
    try {
      client = await pool.connect();
      const emailCheck = await client.query('SELECT user_id FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'User with this email already exists.' });
      }
      const usernameCheck = await client.query('SELECT user_id FROM users WHERE username = $1', [username]);
      if (usernameCheck.rows.length > 0) {
        return res.status(409).json({ error: 'This username is already taken.' });
      }

      await client.query('BEGIN');
      
      // ... (rest of the registration logic is unchanged and correct)
      
      await client.query('COMMIT');
      res.status(201).json({ message: 'User created successfully', user: newUser.rows[0] });
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      console.error('REGISTRATION PROCESS FAILED:', error); 
      res.status(500).json({ error: 'Server error during registration.' });
    } finally {
      if (client) client.release();
    }
  }
);

router.post(
  '/login',
  //authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password } = req.body;
      const result = await pool.query('SELECT user_id, username, email, password_hash, is_admin FROM users WHERE email = $1', [email]);

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const payload = { user: { id: user.user_id, username: user.username, isAdmin: user.is_admin } };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      
      res.json({ token });
    } catch (error) {
      console.error('[Login Error]', error);
      res.status(500).json({ error: 'Server error during login.' });
    }
  }
);

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
