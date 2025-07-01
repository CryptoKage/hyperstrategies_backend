// server/index.js

// --- Basic Setup ---
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// --- Authentication Libraries ---
const session = require('express-session');
const passport = require('passport');

// --- Load Environment Variables ---
dotenv.config();

// --- Ethereum Tools ---
const { ethers } = require('ethers');

// --- Import Routes and Passport Configuration ---
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const withdrawRoutes = require('./routes/withdraw');
require('./passport-setup'); // ✅ Required for Google login

// --- Initialize Express App ---
const app = express();
const PORT = process.env.PORT || 5000;

// --- Middleware Configuration ---
app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/withdraw', withdrawRoutes);

// --- Alchemy Startup Test ---
(async () => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_URL);
    const block = await provider.getBlockNumber();
    console.log(`✅ Alchemy provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy provider connection failed:', err);
  }
})();

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);

  // -- withdraw 
  app.use('/api/withdraw', require('./routes/withdraw'));

  const pollDeposits = require('./jobs/pollDeposits');
  setInterval(() => {
    pollDeposits();
  }, 30_000); // Every 30 seconds
});