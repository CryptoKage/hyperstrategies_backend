// /config/cors.js

const allowedOrigins = [
  process.env.FRONTEND_URL, // e.g., https://www.hyper-strategies.com
  process.env.BACKEND_URL,  // <-- THE DEFINITIVE FIX: Allow the backend to talk to itself
];

if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // Log for any future debugging
    console.log(`[CORS DEBUG] Request from Origin: ${origin}`);

    // Allow requests with no origin (server-to-server, mobile apps, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Check if the origin is in our list or is a Vercel preview URL
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
  },
  credentials: true,
};

module.exports = { corsOptions };
