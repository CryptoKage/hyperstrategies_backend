// server/passport-setup.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('./db');

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

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    const { id, displayName, emails } = profile;
    const email = emails[0].value;

    try {
      // Case A: Check if user exists with this Google ID
      let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [id]);

      if (user.rows.length > 0) {
        // User exists, welcome them back
        return done(null, user.rows[0]);
      } 
      
      // Case B: Google ID not found. Let's check if the email is already in use.
      user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      
      if (user.rows.length > 0) {
        // Email exists. This user has a local account. Let's link it.
        // We will UPDATE their record to add their Google ID.
        const updatedUser = await pool.query(
          'UPDATE users SET google_id = $1 WHERE email = $2 RETURNING *',
          [id, email]
        );
        return done(null, updatedUser.rows[0]);
      }
      
      // Case C: No user found with this Google ID or email. This is a brand new user.
const { generateWallet, encrypt } = require('./utils/walletUtils');

const wallet = generateWallet();
const encryptedKey = encrypt(wallet.privateKey);

const newUser = await pool.query(
  `INSERT INTO users (username, email, google_id, eth_address, eth_private_key_encrypted)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING *`,
  [displayName, email, id, wallet.address, encryptedKey]
);
      return done(null, newUser.rows[0]);

    } catch (err) {
      return done(err, false);
    }
  }
));