/* /config/cors.js */

/**
 * CORS configuration for the API server.
 * Update the `allowedOrigins` array whenever the list of trusted
 * front-end domains changes.
 */

 const allowedOrigins = [
  'http://localhost:3000',
  'https://www.hyper-strategies.com', // <-- The correct domain from the error
  'https://hyper-strategies.com'    // <-- Good practice to include the naked domain too
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
};

module.exports = { corsOptions, allowedOrigins };
