// /config/cors.js

const allowedOrigins = [
  process.env.FRONTEND_URL,
];

if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // --- THIS IS THE DEFINITIVE DIAGNOSTIC LOG ---
    // We will log every single origin that comes into the server.
    console.log(`[CORS DEBUG] Request received from Origin: ${origin}`);
    // --- END OF LOG ---

    if (!origin) {
      return callback(null, true);
    }

    const whitelist = [
      ...allowedOrigins,
      new RegExp(`\\.vercel\\.app$`) 
    ];

    const isAllowed = whitelist.some(allowedOrigin => {
        if (allowedOrigin instanceof RegExp) {
            return allowedOrigin.test(origin);
        }
        return allowedOrigin === origin;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      // The error is happening here. The log above will tell us why.
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
  },
  credentials: true,
};

module.exports = { corsOptions };
