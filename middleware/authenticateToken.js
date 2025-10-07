// middleware/authenticateToken.js
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  // 1. Get the token from the cookie parser
  const token = req.cookies.token;

  // 2. If no token exists, the user is unauthorized
  if (token == null) {
    return res.sendStatus(401); // Unauthorized
  }

  // 3. Verify the token is valid
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      // If the token is expired or invalid, clear the bad cookie and send Forbidden
      res.clearCookie('token');
      return res.sendStatus(403); // Forbidden
    }
    
    // 4. If the token is valid, attach the user payload to the request and continue
    req.user = payload.user;
    next();
  });
}

module.exports = authenticateToken;
