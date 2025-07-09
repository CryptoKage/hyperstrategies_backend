// server/routes/vaults.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Allocate Funds to Vault Endpoint ---
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    // Using BigNumber for precision (assuming 6 decimals for amounts)
    const totalAmount_BN = ethers.utils.parseUnits(amount.toString(), 6);

    if (totalAmount_BN.isNegative() || totalAmount_BN.isZero()) {
      return res.status(400).json({ error: 'Invalid allocation amount.' });
    }

    const userResult = await client.query('SELECT balance FROM users WHERE user_id = $1', [userId]);
    const availableBalance_BN = ethers.utils.parseUnits(userResult.rows[0].balance.toString(), 6);

    if (availableBalance_BN.lt(totalAmount_BN)) {
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    await client.query('BEGIN');

    const tradableAmount_BN = totalAmount_BN.mul(80).div(100);
    const bonusPointsAmount_BN = totalAmount_BN.mul(20).div(100);

    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);
    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);

    const existingPosition = await client.query('SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);

    if (existingPosition.rows.length > 0) {
      const currentCapital_BN = ethers.utils.parseUnits(existingPosition.rows[0].tradable_capital.toString(), 6);
      const newCapital_BN = currentCapital_BN.add(tradableAmount_BN);
      await client.query('UPDATE user_vault_positions SET tradable_capital = $1 WHERE user_id = $2 AND vault_id = $3', [ethers.utils.formatUnits(newCapital_BN, 6), userId, vaultId]);
    } else {
      await client.query('INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital) VALUES ($1, $2, $3)', [userId, vaultId, ethers.utils.formatUnits(tradableAmount_BN, 6)]);
    }
    
    await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [userId, ethers.utils.formatUnits(bonusPointsAmount_BN, 6)]);

    // ✅ NEW: Log this action to the vault_transactions table
    await client.query(
      `INSERT INTO vault_transactions (user_id, vault_id, transaction_type, amount)
       VALUES ($1, $2, 'allocation', $3)`,
      [userId, vaultId, ethers.utils.formatUnits(totalAmount_BN, 6)]
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

// --- Withdraw From Vault Endpoint ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const withdrawAmount_BN = ethers.utils.parseUnits(amount.toString(), 6);

    await client.query('BEGIN');

    const positionResult = await client.query('SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    if (positionResult.rows.length === 0) { throw new Error('User does not have a position in this vault.'); }

    const currentCapital_BN = ethers.utils.parseUnits(positionResult.rows[0].tradable_capital.toString(), 6);
    if (withdrawAmount_BN.gt(currentCapital_BN)) {
      return res.status(400).json({ error: 'Withdrawal amount exceeds tradable capital.' });
    }

    const newCapital_BN = currentCapital_BN.sub(withdrawAmount_BN);
    await client.query('UPDATE user_vault_positions SET tradable_capital = $1 WHERE user_id = $2 AND vault_id = $3', [ethers.utils.formatUnits(newCapital_BN, 6), userId, vaultId]);

    const userResult = await client.query('SELECT balance FROM users WHERE user_id = $1', [userId]);
    const currentBalance_BN = ethers.utils.parseUnits(userResult.rows[0].balance.toString(), 6);
    const newBalance_BN = currentBalance_BN.add(withdrawAmount_BN);
    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);
    
    // ✅ NEW: Log this action to the vault_transactions table
    await client.query(
      `INSERT INTO vault_transactions (user_id, vault_id, transaction_type, amount)
       VALUES ($1, $2, 'withdrawal', $3)`,
      [userId, vaultId, ethers.utils.formatUnits(withdrawAmount_BN, 6)]
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