const pool = require('../db');

function requireTier(minTier) {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;
      const result = await pool.query('SELECT account_tier FROM users WHERE user_id = $1', [userId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const tier = result.rows[0].account_tier;
      if (tier < minTier) {
        return res.status(403).json({ error: `Account tier ${minTier} required` });
      }
      next();
    } catch (err) {
      console.error('Tier check error:', err);
      res.status(500).send('Server Error');
    }
  };
}

module.exports = requireTier;
