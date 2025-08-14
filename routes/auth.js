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

// Ensure a newly generated referral code is not already taken.
// If a collision occurs, a new code is generated and checked again.
// This minimizes the chance of hitting the unique constraint during user creation.
async function generateUniqueReferralCode(db) {
  let code;
  let exists = true;
  while (exists) {
    code = generateReferralCode();
    const result = await db.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    exists = result.rows.length > 0;
  }
  return code;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/register',
  authLimiter,
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
    
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const emailCheck = await client.query('SELECT user_id FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'User with this email already exists.' });
      }
      const usernameCheck = await client.query('SELECT user_id FROM users WHERE username = $1', [username]);
      if (usernameCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This username is already taken.' });
      }

      const userCountResult = await client.query('SELECT COUNT(*) FROM users');
      const currentUserCount = parseInt(userCountResult.rows[0].count);
      
      let xpToAward = 0;
      if (currentUserCount < 100) xpToAward = 25;
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
      
      // --- THE FIX: The INSERT query no longer mentions 'tags' or 'pins' ---
      // This now perfectly matches your 'users' table DDL.
      const newUserQuery = `
        INSERT INTO users (email, password_hash, username, google_id, balance, eth_address, eth_private_key_encrypted, referred_by_user_id, xp, bio, theme, referral_code, is_admin, account_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING user_id, email, username, eth_address`;

      let newUserResult;
      let attempts = 0;
      while (!newUserResult && attempts < 5) {
        const newReferralCode = await generateUniqueReferralCode(client);
        const newUserParams = [
          email, passwordHash, username, null, 0.0, wallet.address,
          encryptedKey, referrerId, xpToAward, null, 'dark',
          newReferralCode, false, 1,
        ];
        try {
          newUserResult = await client.query(newUserQuery, newUserParams);
        } catch (err) {
          if (err.code === '23505' && err.detail?.includes('referral_code')) {
            attempts += 1;
          } else {
            throw err;
          }
        }
      }
      if (!newUserResult) {
        throw new Error('Failed to generate a unique referral code');
      }

      const newlyCreatedUser = newUserResult.rows[0];
      const newUserId = newlyCreatedUser.user_id;

      // --- THE FIX: Assign initial pins in the correct 'user_pins' table ---
      const initialPinsToAssign = ['EARLY_SUPPORTER']; // Default pin for all new users.
      // We can add logic here later to check the referrerId and add a syndicate pin.
      
      for (const pinName of initialPinsToAssign) {
        await client.query(
          'INSERT INTO user_pins (user_id, pin_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [newUserId, pinName]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ message: 'User created successfully', user: newlyCreatedUser });

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
  authLimiter,
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
        const result = await pool.query('SELECT user_id, username, email, password_hash, is_admin, account_tier FROM users WHERE email = $1', [email]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

          const payload = { 
        user: { 
          id: user.user_id, 
          username: user.username, 
          isAdmin: user.is_admin,
          account_tier: user.account_tier // This is the new, crucial piece of data
        } 
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      
      res.json({ token });
    } catch (error) {
      console.error('[Login Error]', error);
      res.status(500).json({ error: 'Server error during login.' });
    }
  }
);

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: process.env.FRONTEND_URL || 'https://www.hyper-strategies.com/login' }),
  async (req, res) => {
    try {
      if (!req.user.referral_code) {
        // Assign a unique referral code to new OAuth users. If an update
        // collides with an existing code, retry with a fresh one.
        let updated = false;
        let attempts = 0;
        while (!updated && attempts < 5) {
          const newCode = await generateUniqueReferralCode(pool);
          try {
            await pool.query('UPDATE users SET referral_code = $1 WHERE user_id = $2', [newCode, req.user.user_id]);
            updated = true;
          } catch (err) {
            if (err.code === '23505' && err.detail && err.detail.includes('referral_code')) {
              attempts += 1;
            } else {
              throw err;
            }
          }
        }
        if (!updated) {
          throw new Error('Failed to assign a unique referral code');
        }
      }
         const freshUserResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [req.user.user_id]);
      const freshUser = freshUserResult.rows[0];

      // Now we build the payload with the fresh data, including the account_tier.
      const payload = { 
        user: { 
          id: freshUser.user_id, 
          username: freshUser.username, 
          isAdmin: freshUser.is_admin,
          account_tier: freshUser.account_tier // This is the crucial piece
        } 
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      const frontend = process.env.FRONTEND_URL || 'https://www.hyper-strategies.com';
      res.redirect(`${frontend}/oauth-success?token=${token}`);
    } catch (err) {
      console.error('Google callback error:', err);
      res.redirect(`${process.env.FRONTEND_URL || 'https://www.hyper-strategies.com'}/login`);
    }
  }
);

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT user_id, username, eth_address FROM users WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in /me:', err.message);
    res.status(500).json({ error: 'Server error while fetching user profile' });
  }
});

module.exports = router;
//comment
