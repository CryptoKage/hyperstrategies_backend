// PASTE THIS ENTIRE CONTENT INTO: hyperstrategies_backend/config/cors.js

const allowedOrigins = [
  process.env.FRONTEND_URL, // Your Vercel URL from .env
];

// In development, we might also allow requests from localhost
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true, // This allows cookies to be sent
};

module.exports = { corsOptions };
