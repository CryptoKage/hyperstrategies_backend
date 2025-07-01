// server/passport-setup.js

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('./db');
const { generateWallet, encrypt } = require('./utils/walletUtils');

// --- Serialize/Deserialize ---
passport.serializeUser((user, done) => {
  done(null, user.user_id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
    done(null, user.rows[0]);
  } catch (err) {
    done(err, null);
  }
});

// --- Strategy Setup ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    const { id: googleId, displayName, emails } = profile;
    const email = emails[0].value;

    try {
      // Case A: Check if user already has a Google ID
      let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
      if (user.rows.length > 0) {
        return done(null, user.rows[0]);
      }

      // Case B: Link Google ID to existing email
      user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (user.rows.length > 0) {
        const updatedUser = await pool.query(
          'UPDATE users SET google_id = $1 WHERE email = $2 RETURNING *',
          [googleId, email]
        );
        return done(null, updatedUser.rows[0]);
      }

      // Case C: New Google user → create account
      let finalUsername = displayName;
      let suffix = 1;

      while (true) {
        const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [finalUsername]);
        if (exists.rowCount === 0) break;
        finalUsername = `${displayName}-${suffix++}`;
      }

      const wallet = generateWallet();
      const encryptedKey = encrypt(wallet.privateKey);

      const newUser = await pool.query(
        `INSERT INTO users (username, email, google_id, eth_address, eth_private_key_encrypted)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [finalUsername, email, googleId, wallet.address, encryptedKey]
      );

      return done(null, newUser.rows[0]);

    } catch (err) {
      console.error('🔥 Google auth error:', err.message);
      return done(err, false);
    }
  }
));
