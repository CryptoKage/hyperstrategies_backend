// /config/cors.js

// --- 1. Define your core allowed domains in a clear, readable array ---
const allowedOrigins = [
  'http://localhost:3000',                  // Development frontend
  'https://hyper-strategies.com',            // Main production domain (without www)
  'https://www.hyper-strategies.com',        // Main production domain (with www)
  'https://app.hyper-strategies.com'         // Future app subdomain
];

const corsOptions = {
  origin: (origin, callback) => {
    // Log for debugging
    // console.log(`[CORS DEBUG] Request from Origin: ${origin}`);

    // --- 2. Allow requests with no origin (like server-to-server or mobile apps) ---
    if (!origin) {
      return callback(null, true);
    }

    // --- 3. Check against the explicit whitelist OR the Vercel preview pattern ---
    // This logic is now cleaner and easier to manage.
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true); // Origin is allowed
    } else {
      // Origin is not in the list, reject it.
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
  },
  credentials: true, // This allows cookies and authorization headers to be sent
};

module.exports = { corsOptions };
