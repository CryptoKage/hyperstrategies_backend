// server/routes/vaults.js

const express = require('express');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Allocate Funds to Vault Endpoint ---
// This is your existing, correct code.
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const totalAmount = parseFloat(amount);
    if (isNaN(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ error: 'Invalid allocation amount.' });
    }

    const userResult = await client.query('SELECT balance FROM users WHERE user_id = $1', [userId]);
    const availableBalance = parseFloat(userResult.rows[0].balance);

    if (availableBalance < totalAmount) {
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    await client.query('BEGIN');

    const tradableAmount = totalAmount * 0.80;
    const bonusPointsAmount = totalAmount * 0.20;

    await client.query('UPDATE users SET balance = balance - $1 WHERE user_id = $2', [totalAmount, userId]);

    const existingPosition = await client.query(
      'SELECT position_id FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2',
      [userId, vaultId]
    );

    if (existingPosition.rows.length > 0) {
      await client.query(
        'UPDATE user_vault_positions SET tradable_capital = tradable_capital + $1 WHERE user_id = $2 AND vault_id = $3',
        [tradableAmount, userId, vaultId]
      );
    } else {
      await client.query(
        'INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital) VALUES ($1, $2, $3)',
        [userId, vaultId, tradableAmount]
      );
    }
    
    await client.query(
      'INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)',
      [userId, bonusPointsAmount]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Allocation successful!' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Allocation transaction error:', err.message);
    res.status(500).json({ error: 'An error occurred during the allocation process.' });
  } finally {
    client.release();
  }
});


// --- ✅ ADDED: Withdraw From Vault Endpoint ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount.' });
    }

    await client.query('BEGIN');

    const positionResult = await client.query(
      'SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2',
      [userId, vaultId]
    );

    if (positionResult.rows.length === 0) {
      throw new Error('User does not have a position in this vault.');
    }

    const currentCapital = parseFloat(positionResult.rows[0].tradable_capital);
    if (withdrawAmount > currentCapital) {
      return res.status(400).json({ error: 'Withdrawal amount exceeds tradable capital in this vault.' });
    }

    await client.query(
      'UPDATE user_vault_positions SET tradable_capital = tradable_capital - $1 WHERE user_id = $2 AND vault_id = $3',
      [withdrawAmount, userId, vaultId]
    );

    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
      [withdrawAmount, userId]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Withdrawal from vault successful!' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vault withdrawal transaction error:', err.message);
    res.status(500).json({ error: 'An error occurred during the withdrawal process.' });
  } finally {
    client.release();
  }
});


module.exports = router;