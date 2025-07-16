// server/middleware/isAdmin.js
const isAdmin = (req, res, next) => {
  // This runs AFTER authenticateToken, so req.user exists
  if (req.user && req.user.isAdmin) {
    next(); // User is an admin, proceed
  } else {
    res.status(403).json({ error: 'Forbidden: Admin access required.' });
  }
};
module.exports = isAdmin;