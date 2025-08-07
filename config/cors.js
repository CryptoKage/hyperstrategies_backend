/* /config/cors.js */

/**
 * CORS configuration for the API server.
 * Update the `allowedOrigins` array whenever the list of trusted
 * front-end domains changes.
 */
const allowedOrigins = [
  'http://localhost:3000',
  'https://hyperstrategies.io'
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
};

module.exports = { corsOptions, allowedOrigins };
