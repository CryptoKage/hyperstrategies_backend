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
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { autoEquipBestPins } = require('../utils/pinUtils');
const { TIER_DATA } = require('../utils/tierUtils');
const { sendEmail } = require('../utils/msGraphMailer');
const { awardXp } = require('../utils/xpEngine');

const cookieOptions = {
  httpOnly: true,
  secure: (process.env.COOKIE_SECURE || '').toLowerCase() === 'true' || process.env.NODE_ENV === 'production',
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  domain: process.env.COOKIE_DOMAIN || (process.env.NODE_ENV === 'production' ? '.hyper-strategies.com' : undefined),
  maxAge: 8 * 60 * 60 * 1000 // 8 hours
};

function generateReferralCode() {
  return 'HS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

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
        const referrerResult = await client.query(
          'SELECT user_id FROM users WHERE LOWER(referral_code) = LOWER($1)', 
          [referralCode]
        );
        if (referrerResult.rows.length > 0) {
          referrerId = referrerResult.rows[0].user_id;
        }
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      const wallet = generateWallet();
      const encryptedKey = encrypt(wallet.privateKey);
      
      const newUserQuery = `
        INSERT INTO users (email, password_hash, username, google_id, balance, eth_address, eth_private_key_encrypted, referred_by_user_id, xp, bio, theme, referral_code, is_admin, account_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING user_id, email, username, eth_address`;

      // We set initial XP to 0 here, as the engine will handle the addition.
      const initialXp = 0; 
      
      let newUserResult;
      let attempts = 0;
      while (!newUserResult && attempts < 5) {
        const newReferralCode = await generateUniqueReferralCode(client);
        const newUserParams = [
          email, passwordHash, username, null, 0.0, wallet.address,
          encryptedKey, referrerId, initialXp, null, 'dark',
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

      if (xpToAward > 0) {
  await awardXp({
    userId: newUserId,
    xpAmount: xpToAward,
    type: 'SIGNUP_BONUS',
    descriptionKey: 'xp_history.signup_bonus', 
    descriptionVars: { amount: xpToAward }      
  }, client);
}
     
      if (referralCode) {
            const syndicateResult = await client.query(
                'SELECT pin_name_to_grant FROM syndicates WHERE referral_code = $1',
                [referralCode.toLowerCase()]
            );
            if (syndicateResult.rows.length > 0) {
                const pinToMint = syndicateResult.rows[0].pin_name_to_grant;
                await client.query(
                    'INSERT INTO pins (owner_id, pin_name) VALUES ($1, $2)',
                    [newUserId, pinToMint]
                );
                 await autoEquipBestPins(newUserId, client);
            }
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
      const result = await pool.query('SELECT user_id, username, email, password_hash, is_admin, account_tier, xp FROM users WHERE email = $1', [email]);
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const currentTierInfo = TIER_DATA.find(t => t.tier === user.account_tier) || TIER_DATA[0];
      const nextTierInfo = TIER_DATA.find(t => t.tier === user.account_tier + 1);

      const payload = { 
        user: { 
          id: user.user_id, 
          username: user.username, 
          isAdmin: user.is_admin,
          account_tier: user.account_tier,
          xp: parseFloat(user.xp),
          currentTierXp: currentTierInfo.xpRequired, 
          nextTierXp: nextTierInfo ? nextTierInfo.xpRequired : null 
        } 
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      
      // CRITICAL FIX: Set the cookie for the parent domain
      res.cookie('token', token, cookieOptions);
      

      // Send ONE response that includes the user object for the frontend context.
      res.status(200).json({ message: 'Login successful', user: payload.user });

    } catch (err) {
      console.error('[Login Error]', err);
      res.status(500).json({ error: 'Server error during login.' });
    }
  }
);

router.get('/google', (req, res, next) => {
  const referralCode = req.query.ref;
  const state = referralCode 
    ? Buffer.from(JSON.stringify({ referralCode })).toString('base64')
    : undefined;

  // Destroy any existing session before starting the new authentication flow.
  req.logout(function(err) {
    if (err) { 
      console.error('req.logout FAILED:', err);
      return next(err); 
    }
    
    // Passport's logout is enough, no need for req.session.destroy() which caused issues.
    console.log('req.logout() successful. Now starting Google authentication.');
    
    const authenticator = passport.authenticate('google', { 
      scope: ['profile', 'email'],
      state: state,
      prompt: 'select_account'
    });
    
    authenticator(req, res, next);
  });
});


router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: process.env.FRONTEND_URL || 'https://www.hyper-strategies.com/login', session: false }),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const googleUser = req.user; 

      if (req.query.state) {
        try {
          const decodedState = JSON.parse(Buffer.from(req.query.state, 'base64').toString('ascii'));
          const referralCode = decodedState.referralCode;

          if (referralCode && !googleUser.referred_by_user_id) {
            console.log(`[OAuth] Applying referral code ${referralCode} to new user ${googleUser.user_id}`);
            
            const referrerResult = await client.query('SELECT user_id FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerResult.rows.length > 0) {
              const referrerId = referrerResult.rows[0].user_id;
              await client.query('UPDATE users SET referred_by_user_id = $1 WHERE user_id = $2', [referrerId, googleUser.user_id]);
            }

            const syndicateResult = await client.query('SELECT pin_name_to_grant FROM syndicates WHERE referral_code = $1', [referralCode.toLowerCase()]);
            if (syndicateResult.rows.length > 0) {
              const pinToMint = syndicateResult.rows[0].pin_name_to_grant;
              await client.query('INSERT INTO pins (owner_id, pin_name) VALUES ($1, $2)', [googleUser.user_id, pinToMint]);
              console.log(`[OAuth] Minted Syndicate Pin '${pinToMint}' for user ${googleUser.user_id}`);
            }
          }
        } catch (stateError) {
          console.error('[OAuth] Failed to decode or process referral state:', stateError);
        }
      }
      
      const currentTierInfo = TIER_DATA.find(t => t.tier === googleUser.account_tier) || TIER_DATA[0];
      const nextTierInfo = TIER_DATA.find(t => t.tier === googleUser.account_tier + 1);

      const payload = { 
        user: { 
          id: googleUser.user_id, 
          username: googleUser.username, 
          isAdmin: googleUser.is_admin,
          account_tier: googleUser.account_tier,
          xp: parseFloat(googleUser.xp),
          currentTierXp: currentTierInfo.xpRequired, 
          nextTierXp: nextTierInfo ? nextTierInfo.xpRequired : parseFloat(googleUser.xp) 
        } 
      };
       const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
      const frontend = process.env.FRONTEND_URL || 'https://www.hyper-strategies.com';

      res.cookie('token', token, cookieOptions);
      
      await client.query('COMMIT');
      
      res.redirect(`${process.env.FRONTEND_URL}/oauth-success`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Google callback transaction error:', err);
      res.redirect(`${process.env.FRONTEND_URL || 'https://www.hyper-strategies.com'}/login?error=oauth_failed`);
    } finally {
      client.release();
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

router.post('/forgot-password', authLimiter, [ body('email').isEmail().normalizeEmail() ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email } = req.body;
    try {
      const userResult = await pool.query('SELECT user_id FROM users WHERE email = $1', [email]);
      
      // Security: Always return the same message to prevent email enumeration attacks.
      if (userResult.rows.length === 0) {
        return res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });
      }
      const user = userResult.rows[0];

      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      const tokenExpires = new Date(Date.now() + 3600000); // Token expires in 1 hour

      await pool.query(
        'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE user_id = $3',
        [hashedToken, tokenExpires, user.user_id]
      );

      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
      
      await sendEmail({
        to: email,
        subject: 'Your HyperStrategies Password Reset Link',
        html: `<p>You requested a password reset. Please click this link to set a new password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link will expire in one hour.</p>`,
      });
      
      res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });

    } catch (err) {
      console.error('Forgot password error:', err);
      // Don't leak internal errors to the user.
      res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });
    }
  }
);

router.post(
  '/reset-password',
  authLimiter,
  [
    body('token').notEmpty().withMessage('Token is required.'),
    body('password').isStrongPassword().withMessage('Please provide a stronger password.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { token, password } = req.body;
    try {
      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
      const userResult = await pool.query(
        'SELECT user_id FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
        [hashedToken]
      );

      if (userResult.rows.length === 0) {
        return res.status(400).json({ error: 'Password reset token is invalid or has expired.' });
      }
      const user = userResult.rows[0];

      const salt = await bcrypt.genSalt(10);
      const newPasswordHash = await bcrypt.hash(password, salt);

      await pool.query(
        'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE user_id = $2',
        [newPasswordHash, user.user_id]
      );
      
      res.status(200).json({ message: 'Password has been successfully reset. You can now log in.' });

    } catch (err) {
      console.error('Reset password error:', err);
      res.status(500).json({ error: 'An error occurred.' });
    }
  }
);

router.post('/refresh-token', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      'SELECT user_id, username, is_admin, account_tier, xp FROM users WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = result.rows[0];
    
    // We include the tier data here for the XP bar
    const currentTierInfo = TIER_DATA.find(t => t.tier === user.account_tier) || TIER_DATA[0];
    const nextTierInfo = TIER_DATA.find(t => t.tier === user.account_tier + 1);

    const payload = { 
      user: { 
        id: user.user_id, 
        username: user.username, 
        isAdmin: user.is_admin,
        account_tier: user.account_tier,
        xp: parseFloat(user.xp),
        currentTierXp: currentTierInfo.xpRequired, 
        nextTierXp: nextTierInfo ? nextTierInfo.xpRequired : parseFloat(user.xp)
      } 
    };
    
     const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });


     res.cookie('token', token, cookieOptions);
     res.status(200).json({ user: payload.user });

  } catch (err) {
    console.error('[Token Refresh Error]', err);
    res.status(500).json({ error: 'Server error during token refresh.' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { 
    domain: cookieOptions.domain, 
    path: '/',
  });
  res.status(200).json({ message: 'Logout successful' });
});

module.exports = router;
