// server/index.js
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const passport = require('passport');
const ethers = require('ethers');
const pinsRouter = require('./routes/pins');
const adminPinsRouter = require('./routes/adminPins');
const { getProvider } = require('./utils/alchemyWebsocketProvider');

dotenv.config();

// --- Startup Configuration Checks ---
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim() === '') {
  console.error('FATAL ERROR: SESSION_SECRET environment variable is not defined.');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('FATAL ERROR: ENCRYPTION_KEY environment variable is not defined or is too short.');
  process.exit(1);
}

// --- Route Imports ---
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

// --- Middleware ---
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());

const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'strict' : 'lax'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/vaults', vaultsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/pins', pinsRouter);
app.use('/api/admin/pins', adminPinsRouter);

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

  let isPollingDeposits = false;
  let isProcessingWithdrawals = false;
  let isProcessingTimeRewards = false;
  let isProcessingVaultWithdrawals = false;
  let isSweepingLedger = false; // New lock for our new job

  // Job 1: Poll for new platform deposits on each finalized block
  const { pollDeposits, initializeProvider } = require('./jobs/pollDeposits');
  initializeProvider();
  
 const wsProvider = getProvider(); 
  const finalityBuffer = 5;
  wsProvider.on('block', async (blockNumber) => {
    const finalizedBlock = blockNumber - finalityBuffer;
    if (finalizedBlock <= 0 || isPollingDeposits) { return; }
    isPollingDeposits = true;
    try { await pollDeposits({ toBlock: finalizedBlock }); }
    catch (e) { console.error('Error in pollDeposits job:', e); }
    finally { isPollingDeposits = false; }
  });

  // Job 2: Process platform withdrawal queue (every 45 seconds)
  const { processWithdrawals } = require('./jobs/queueProcessor');
  setInterval(async () => {
    if (isProcessingWithdrawals) { return; }
    isProcessingWithdrawals = true;
    try { await processWithdrawals(); } catch (e) { console.error('Error in processWithdrawals job:', e); }
    finally { isProcessingWithdrawals = false; }
  }, 45000);

  // Job 3: Sweep newly deposited funds to the trading desk (every 10 minutes)
  const { processLedgerSweeps } = require('./jobs/processLedgerSweeps');
  const TEN_MINUTES_IN_MS = 10 * 60 * 1000;
  setInterval(async () => {
    if (isSweepingLedger) { return; }
    isSweepingLedger = true;
    try { await processLedgerSweeps(); } catch (e) { console.error('Error in processLedgerSweeps job:', e); }
    finally { isSweepingLedger = false; }
  }, TEN_MINUTES_IN_MS);

  // Job 4: Award time-weighted staking XP (every 24 hours)
  const { processTimeWeightedRewards } = require('./jobs/awardStakingXP');
  const TWENTY_FOUR_HOURS_IN_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    if (isProcessingTimeRewards) { return; }
    isProcessingTimeRewards = true;
    try { await processTimeWeightedRewards(); } catch (e) { console.error('Error in processTimeWeightedRewards job:', e); }
    finally { isProcessingTimeRewards = false; }
  }, TWENTY_FOUR_HOURS_IN_MS);

  // Job 5: Process pending INTERNAL vault withdrawals (every minute)
  const { processPendingVaultWithdrawals } = require('./jobs/processVaultWithdrawals');
  const SIXTY_SECONDS_IN_MS = 60 * 1000;
  setInterval(async () => {
    if (isProcessingVaultWithdrawals) { return; }
    isProcessingVaultWithdrawals = true;
    try { await processPendingVaultWithdrawals(); } catch (e) { console.error('Error in processVaultWithdrawals job:', e); }
    finally { isProcessingVaultWithdrawals = false; }
  }, SIXTY_SECONDS_IN_MS);
});

