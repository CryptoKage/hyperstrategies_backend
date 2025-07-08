// server/routes/vaults.js

const express = require('express');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Invest in Vault Endpoint ---
// This handles the 80/20 split and loyalty points logic
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect(); // Get a client from the pool for a transaction

  try {
    const totalAmount = parseFloat(amount);
    if (isNaN(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ error: 'Invalid investment amount.' });
    }

    // Check if user has enough available balance
    const userResult = await client.query('SELECT balance FROM users WHERE user_id = $1', [userId]);
    const availableBalance = parseFloat(userResult.rows[0].balance);

    if (availableBalance < totalAmount) {
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    // --- Start the Database Transaction ---
    await client.query('BEGIN');

    // 1. Calculate the 80/20 split
    const tradableAmount = totalAmount * 0.80;
    const loyaltyPointsAmount = totalAmount * 0.20;

    // 2. Debit the full amount from the user's main wallet balance
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
      [totalAmount, userId]
    );

    // 3. Add the 80% to their vault position.
    // We check if they already have a position to update; otherwise, we create a new one.
    const existingPosition = await client.query(
      'SELECT position_id FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2',
      [userId, vaultId]
    );

    if (existingPosition.rows.length > 0) {
      // User already has a position, so we add to it
      await client.query(
        'UPDATE user_vault_positions SET tradable_capital = tradable_capital + $1 WHERE user_id = $2 AND vault_id = $3',
        [tradableAmount, userId, vaultId]
      );
    } else {
      // This is the user's first investment in this vault
      await client.query(
        'INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital) VALUES ($1, $2, $3)',
        [userId, vaultId, tradableAmount]
      );
    }
    
    // 4. Record the 20% as Loyalty Points
    await client.query(
      'INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)',
      [userId, loyaltyPointsAmount]
    );

    // --- All steps successful, commit the transaction ---
    await client.query('COMMIT');

    res.status(200).json({ message: 'Investment successful!' });

  } catch (err) {
    // If any step above fails, this will roll back all previous steps in the transaction
    await client.query('ROLLBACK');
    console.error('Investment transaction error:', err.message);
    res.status(500).json({ error: 'An error occurred during the investment process.' });
  } finally {
    // ALWAYS release the client back to the pool
    client.release();
  }
});

module.exports = router;