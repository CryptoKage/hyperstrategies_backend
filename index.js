// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/index.js

const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const passport = require('passport');
const ethers = require('ethers');
const rateLimit = require('express-rate-limit');

// --- Route Imports ---
const { corsOptions } = require('./config/cors');
const pinsRouter = require('./routes/pins');
const adminPinsRouter = require('./routes/adminPins');
const authXRoutes = require('./routes/authX');
const bountyRoutes = require('./routes/bounties');
const pinsMarketplaceRoutes = require('./routes/pinsMarketplace');
const statsRoutes = require('./routes/stats');
const vaultDetailsRoutes = require('./routes/vaultDetails');
//const pnlRoutes = require('./routes/pnl');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const withdrawRoutes = require('./routes/withdraw');
const vaultsRoutes = require('./routes/vaults');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
require('./passport-setup');

// --- Job & Utility Imports ---
const { updateVaultPerformance } = require('./jobs/updateVaultPerformance');
const { verifyWithdrawalSweeps } = require('./jobs/verifyWithdrawalSweeps');
const { initializeWebSocketProvider } = require('./utils/alchemyWebsocketProvider'); 
const { subscribeToNewBlocks } = require('./jobs/pollDeposits'); 
const cron = require('node-cron');


// --- Startup Configuration Checks ---
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined.');
  process.exit(1);
}
// ... (rest of your startup checks)

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// --- Middleware ---
app.use(cors(corsOptions));
app.use(helmet());

const globalLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 250, // Increase the limit
	standardHeaders: true,
	legacyHeaders: false, 
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});
app.use(globalLimiter);

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
app.use('/api/auth/x', authXRoutes);
app.use('/api/bounties', bountyRoutes);
app.use('/api/pins-marketplace', pinsMarketplaceRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/vault-details', vaultDetailsRoutes);
//app.use('/api/pnl', pnlRoutes);


app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const block = await provider.getBlockNumber();
    console.log(`✅ Alchemy REST provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy REST provider connection failed:', err);
  }

  // --- Initialize All Background Jobs & Services ---
  console.log('🕒 Initializing background jobs and services...');

  initializeWebSocketProvider();
  subscribeToNewBlocks();
  
  // Job 2: Process platform withdrawal queue (every 45 seconds)
  let isProcessingWithdrawals = false;
  const { processWithdrawals } = require('./jobs/queueProcessor');
  setInterval(async () => {
    if (isProcessingWithdrawals) { return; }
    isProcessingWithdrawals = true;
    try { await processWithdrawals(); } catch (e) { console.error('Error in processWithdrawals job:', e); }
    finally { isProcessingWithdrawals = false; }
  }, 45000);

  // Job 3: Sweep newly deposited funds to the trading desk (every 10 minutes)
  let isSweepingLedger = false;
  const { processLedgerSweeps } = require('./jobs/processLedgerSweeps');
  const TEN_MINUTES_IN_MS = 10 * 60 * 1000;
  setInterval(async () => {
    if (isSweepingLedger) { return; }
    isSweepingLedger = true;
    try { await processLedgerSweeps(); } catch (e) { console.error('Error in processLedgerSweeps job:', e); }
    finally { isSweepingLedger = false; }
  }, TEN_MINUTES_IN_MS);

  // Job 4: Award time-weighted staking XP (every 24 hours)
  let isProcessingTimeRewards = false;
  const { processTimeWeightedRewards } = require('./jobs/awardStakingXP');
  const TWENTY_FOUR_HOURS_IN_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    if (isProcessingTimeRewards) { return; }
    isProcessingTimeRewards = true;
    try { await processTimeWeightedRewards(); } catch (e) { console.error('Error in processTimeWeightedRewards job:', e); }
    finally { isProcessingTimeRewards = false; }
  }, TWENTY_FOUR_HOURS_IN_MS);
  
  // Job 5 & 6 (Cron Jobs)
  cron.schedule('0 * * * *', () => {
    console.log('Triggering scheduled hourly vault performance update...');
    updateVaultPerformance();
  });

  cron.schedule('0 */4 * * *', () => {
    console.log('Triggering scheduled withdrawal sweep verification...');
    verifyWithdrawalSweeps();
  });
});
