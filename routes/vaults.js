// server/routes/vaults.js

const express = require('express');
const { ethers } = require('ethers'); // Using v5 syntax to match your backend's package.json
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Allocate Funds to Vault Endpoint ---
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const totalAmount_str = amount.toString();
    if (isNaN(parseFloat(totalAmount_str)) || parseFloat(totalAmount_str) < 100) {
      return res.status(400).json({ error: 'Minimum allocation is $100.' });
    }

    const totalAmount_BN = ethers.utils.parseUnits(totalAmount_str, 6);

    await client.query('BEGIN');

    const userResult = await client.query('SELECT balance, referred_by_user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    const availableBalance_BN = ethers.utils.parseUnits(userResult.rows[0].balance.toString(), 6);

    if (availableBalance_BN.lt(totalAmount_BN)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    const positionCheck = await client.query('SELECT COUNT(*) FROM user_vault_positions WHERE user_id = $1', [userId]);
    const isFirstAllocation = parseInt(positionCheck.rows[0].count) === 0;

    const tradableAmount_BN = totalAmount_BN.mul(80).div(100);
    const bonusPointsAmount_BN = totalAmount_BN.mul(20).div(100);
    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);

    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);

    // ✅ THIS IS THE CORRECT, COMPLETE LOGIC
    const existingPosition = await client.query('SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    if (existingPosition.rows.length > 0) {
      const currentCapital_BN = ethers.utils.parseUnits(existingPosition.rows[0].tradable_capital.toString(), 6);
      const newCapital_BN = currentCapital_BN.add(tradableAmount_BN);
      await client.query('UPDATE user_vault_positions SET tradable_capital = $1 WHERE user_id = $2 AND vault_id = $3', [ethers.utils.formatUnits(newCapital_BN, 6), userId, vaultId]);
    } else {
      await client.query('INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital) VALUES ($1, $2, $3)', [userId, vaultId, ethers.utils.formatUnits(tradableAmount_BN, 6)]);
    }
    
    await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [userId, ethers.utils.formatUnits(bonusPointsAmount_BN, 6)]);
    await client.query(`INSERT INTO vault_transactions (user_id, vault_id, transaction_type, amount) VALUES ($1, $2, 'allocation', $3)`, [userId, vaultId, totalAmount_str]);

    // XP Logic
    const xpForAmount = Math.floor(parseFloat(totalAmount_str) / 10);
    if (xpForAmount > 0) {
      await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
    }
    if (isFirstAllocation) {
      const referrerId = userResult.rows[0].referred_by_user_id;
      if (referrerId) {
        const referralXP = Math.floor(parseFloat(totalAmount_str) / 10);
        await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [referralXP, referrerId]);
      }
    }

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
// This code is complete and correct.
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
    await client.query(`INSERT INTO vault_transactions (user_id, vault_id, transaction_type, amount) VALUES ($1, $2, 'withdrawal', $3)`,[userId, vaultId, ethers.utils.formatUnits(withdrawAmount_BN, 6)]);
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