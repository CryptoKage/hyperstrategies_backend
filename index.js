// server/index.js

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const session = require('express-session');
const passport = require('passport');
const { ethers } = require('ethers');

// Load env vars
dotenv.config();

// Import routes and passport setup
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const withdrawRoutes = require('./routes/withdraw');
const vaultsRoutes = require('./routes/vaults');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
require('./passport-setup');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set to true in prod with HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/vaults', vaultsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);


// Alchemy test
(async () => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const block = await provider.getBlockNumber();
    console.log(`✅ Alchemy provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy provider connection failed:', err);
  }
})();

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Start polling job
  const { pollDeposits, initializeProvider } = require('./jobs/pollDeposits');
  await initializeProvider();

  setInterval(() => {
    pollDeposits();
  }, 30_000);

  const { processWithdrawals } = require('./jobs/queueProcessor');

setInterval(() => {
  processWithdrawals();
}, 45_000); // run every 45s
});
