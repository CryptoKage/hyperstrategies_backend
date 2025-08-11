// server/index.js
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');

const helmet = require('helmet');
const session = require('express-session');
const passport = require('passport');
const ethers = require('ethers'); // Use the main ethers import

// Load env vars
dotenv.config();

// Fail fast if the session secret is missing or empty.
// This ensures cookies are properly signed in all environments.
// --- Add the new JWT_SECRET check here ---
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined.');
  process.exit(1); // Exit the process with an error code
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim() === '') {
  console.error('FATAL ERROR: SESSION_SECRET environment variable is not defined.');
  process.exit(1);
}
// You could also add one for ENCRYPTION_KEY here for consistency
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('FATAL ERROR: ENCRYPTION_KEY environment variable is not defined or is too short.');
  process.exit(1);
}
// Import routes and passport setup
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const withdrawRoutes = require('./routes/withdraw');
const vaultsRoutes = require('./routes/vaults');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
require('./passport-setup');
const { corsOptions } = require('./config/cors');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());


// Configure session cookies with environment-aware security settings.
// In production we enforce HTTPS and use a stricter sameSite policy.
// During development we relax these settings to ease local testing.
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  // Only create sessions when something is stored to avoid setting
  // unnecessary cookies for unauthenticated requests.
  saveUninitialized: false,
  cookie: {
    secure: isProduction, // Only send cookies over HTTPS in production
    httpOnly: true, // Prevent client-side JS from accessing the cookie
    sameSite: isProduction ? 'strict' : 'lax' // Stricter CSRF protection in production
  }
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
