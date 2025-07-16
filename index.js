// server/index.js

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const session = require('express-session');
const passport = require('passport');
const ethers = require('ethers'); // Use the main ethers import

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
  cookie: { secure: false }
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


// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    // Correct ethers v5 syntax for the test
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const block = await provider.getBlockNumber();
    console.log(`✅ Alchemy provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy provider connection failed:', err);
  }

  // --- Initialize All Background Jobs ---
  console.log('🕒 Initializing background jobs...');

  // Job 1: Poll for new platform deposits
  const { pollDeposits } = require('./jobs/pollDeposits');
  setInterval(() => {
    pollDeposits();
  }, 30000); // 30 seconds

  // Job 2: Process platform withdrawal queue
  const { processWithdrawals } = require('./jobs/queueProcessor');
  setInterval(() => {
    processWithdrawals();
  }, 45000); // 45 seconds

  // Job 3: Process vault allocations (the sweep job)
  const { processAllocations } = require('./jobs/processAllocations');
  const FOUR_HOURS_IN_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    processAllocations();
  }, FOUR_HOURS_IN_MS); // 4 hours
});