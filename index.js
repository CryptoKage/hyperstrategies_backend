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

// --- Import Routes and Passport Configuration ---
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard'); // Your new dashboard routes
require('./passport-setup'); // ✅ THIS LINE IS CRITICAL for Google Login. It must be here.

// --- Initialize Express App ---
const app = express();
const PORT = process.env.PORT || 5000;

// --- Middleware Configuration ---

// Enable CORS (Cross-Origin Resource Sharing)
app.use(cors());

// Enable Express to parse JSON bodies in requests
app.use(express.json());

// Configure Session Middleware (for Passport)
app.use(session({
  secret: process.env.SESSION_SECRET, 
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // For production with HTTPS, set this to true
}));

// Initialize Passport Middleware (must be after session)
app.use(passport.initialize());
app.use(passport.session());

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes); // Your new protected dashboard route

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);

 // -- withdraw 
app.use('/api/withdraw', require('./routes/withdraw'));

const pollDeposits = require('./jobs/pollDeposits');

setInterval(() => {
  pollDeposits();
}, 30_000); // 30 seconds


});