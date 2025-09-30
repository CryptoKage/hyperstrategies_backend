// /config/cors.js

const allowedOrigins = [
  process.env.FRONTEND_URL, // Your main production URL, e.g., https://www.hyper-strategies.com
];

// In development, we also want to allow requests from our local React server
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // The 'origin' is the URL of the site making the request.
    // For the Twitter callback, this can sometimes be undefined.

    // --- THIS IS THE DEFINITIVE FIX ---
    // 1. Allow requests that have NO origin (like server-to-server calls from Twitter, or mobile apps)
    if (!origin) {
      return callback(null, true);
    }
    
    // 2. Allow requests from our main frontend URL and all Vercel preview URLs.
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    
    // 3. If it's none of the above, reject it.
    callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    // --- END OF FIX ---
  },
  credentials: true,
};

module.exports = { corsOptions };
