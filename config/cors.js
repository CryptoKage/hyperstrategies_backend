// /config/cors.js

// This is the definitive list of URLs that are allowed to make requests to your backend.
const allowedOrigins = [
  process.env.FRONTEND_URL, // Your main production URL, e.g., https://www.hyper-strategies.com
];

// In development, we also allow requests from our local React server.
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // Log for any future debugging.
    console.log(`[CORS DEBUG] Request from Origin: ${origin}`);

    // Allow requests with no origin (like server-to-server calls from Twitter or mobile apps).
    if (!origin) {
      return callback(null, true);
    }

    // --- THIS IS THE DEFINITIVE FIX ---
    // We check if the incoming origin is in our list of allowed frontend URLs,
    // OR if it is a Vercel preview deployment.
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      callback(null, true); // Allow the request.
    } else {
      // If the origin is anything else, reject it.
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
    // --- END OF FIX ---
  },
  credentials: true,
};

module.exports = { corsOptions };
