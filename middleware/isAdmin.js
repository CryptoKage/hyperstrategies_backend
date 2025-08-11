// server/middleware/isAdmin.js
const pool = require('../db');

/**
 * Verifies that the authenticated user still has admin privileges by querying
 * the database rather than trusting the JWT payload.
 */
const isAdmin = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: User information missing.' });
    }

    const { rows } = await pool.query('SELECT is_admin FROM users WHERE user_id = $1', [req.user.id]);

    if (rows.length && rows[0].is_admin) {
      return next(); // User is an admin, proceed
    }

    return res.status(403).json({ error: 'Forbidden: Admin access required.' });
  } catch (err) {
    console.error('Admin check failed:', err);
    return res.status(500).json({ error: 'Server error verifying admin status.' });
  }
};

module.exports = isAdmin;
