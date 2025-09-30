// /config/cors.js

const allowedOrigins = [
  process.env.FRONTEND_URL, // Your main production URL
];

// In development, allow local React server
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const corsOptions = {
  origin: (origin, callback) => {
    // --- THIS IS THE DEFINITIVE, ROBUST FIX ---
    // The 'origin' is the URL of the site making the request.

    // 1. If the request has no origin (like a server-to-server call from Twitter, a mobile app, or a REST client),
    //    we will always allow it. This is safe and standard practice for public APIs.
    if (!origin) {
      return callback(null, true);
    }

    // 2. We now create a dynamic whitelist that includes our static origins
    //    and a pattern for all Vercel preview deployments.
    const whitelist = [
      ...allowedOrigins,
      // This is a Regular Expression that matches any subdomain of vercel.app
      new RegExp(`\\.vercel\\.app$`) 
    ];

    // 3. We test if the incoming origin matches anything in our whitelist.
    const isAllowed = whitelist.some(allowedOrigin => {
        if (allowedOrigin instanceof RegExp) {
            return allowedOrigin.test(origin);
        }
        return allowedOrigin === origin;
    });

    if (isAllowed) {
      // If it's on the list, allow it.
      callback(null, true);
    } else {
      // If it's not on the list, reject it.
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
    // --- END OF FIX ---
  },
  credentials: true,
};

module.exports = { corsOptions };
