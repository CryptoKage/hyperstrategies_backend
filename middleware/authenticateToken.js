// server/middleware/authenticateToken.js
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  // Get token from the Authorization header (e.g., 'Bearer TOKEN')
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401); // No token, unauthorized

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.sendStatus(403); // Token is no longer valid
    
    // The payload contains the user object we put in it during login
    req.user = payload.user; 
    next(); // Proceed to the route's handler
  });
}

module.exports = authenticateToken;