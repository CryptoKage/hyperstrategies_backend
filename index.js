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

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const block = await provider.getBlockNumber();
    console.log(`✅ Alchemy provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy provider connection failed:', err);
  }

  // --- Initialize All Background Jobs ---
  console.log('🕒 Initializing background jobs with anti-overlap protection...');

  // --- NEW: Define lock variables ---
  let isPollingDeposits = false;
  let isProcessingWithdrawals = false;
  let isProcessingAllocations = false;
  let isProcessingTimeRewards = false;
  let isProcessingVaultWithdrawals = false;

  // Job 1: Poll for new platform deposits
  const { pollDeposits } = require('./jobs/pollDeposits');
  setInterval(async () => {
    if (isPollingDeposits) {
      console.log('SKIPPING: pollDeposits is already running.');
      return;
    }
    isPollingDeposits = true;
    try {
      await pollDeposits();
    } catch (e) {
      console.error('Error in pollDeposits job interval:', e);
    } finally {
      isPollingDeposits = false;
    }
  }, 30000); // 30 seconds

  // Job 2: Process platform withdrawal queue
  const { processWithdrawals } = require('./jobs/queueProcessor');
  setInterval(async () => {
    if (isProcessingWithdrawals) {
      console.log('SKIPPING: processWithdrawals is already running.');
      return;
    }
    isProcessingWithdrawals = true;
    try {
      await processWithdrawals();
    } catch (e) {
      console.error('Error in processWithdrawals job interval:', e);
    } finally {
      isProcessingWithdrawals = false;
    }
  }, 45000); // 45 seconds

  // Job 3: Process vault allocations (the sweep job)
  const { processAllocations } = require('./jobs/processAllocations');
  const FOUR_HOURS_IN_MS = 4 * 60 * 60 * 1000;
  setInterval(async () => {
    if (isProcessingAllocations) {
      console.log('SKIPPING: processAllocations is already running.');
      return;
    }
    isProcessingAllocations = true;
    try {
      await processAllocations();
    } catch (e) {
      console.error('Error in processAllocations job interval:', e);
    } finally {
      isProcessingAllocations = false;
    }
  }, FOUR_HOURS_IN_MS); // 4 hours

  // Job 4: Award time-weighted staking XP and update tiers
  const { processTimeWeightedRewards } = require('./jobs/awardStakingXP');
  const TWENTY_FOUR_HOURS_IN_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    if (isProcessingTimeRewards) {
      console.log('SKIPPING: processTimeWeightedRewards is already running.');
      return;
    }
    isProcessingTimeRewards = true;
    try {
      await processTimeWeightedRewards();
    } catch (e) {
      console.error('Error in processTimeWeightedRewards job interval:', e);
    } finally {
      isProcessingTimeRewards = false;
    }
  }, TWENTY_FOUR_HOURS_IN_MS); // Runs once every 24 hours

  // Run once on startup for testing purposes
  // Note: We wrap this in the same protection to avoid conflict with the first interval run
  (async () => {
    if (isProcessingTimeRewards) return;
    isProcessingTimeRewards = true;
    await processTimeWeightedRewards();
    isProcessingTimeRewards = false;
  })();

  // Job 5: Process pending INTERNAL vault withdrawals
  const { processPendingVaultWithdrawals } = require('./jobs/processVaultWithdrawals');
  const SIXTY_SECONDS_IN_MS = 60 * 1000;
  setInterval(async () => {
    if (isProcessingVaultWithdrawals) {
      console.log('SKIPPING: processPendingVaultWithdrawals is already running.');
      return;
    }
    isProcessingVaultWithdrawals = true;
    try {
      await processPendingVaultWithdrawals();
    } catch (e) {
      console.error('Error in processPendingVaultWithdrawals job interval:', e);
    } finally {
      isProcessingVaultWithdrawals = false;
    }
  }, SIXTY_SECONDS_IN_MS); // Runs once every minute
});