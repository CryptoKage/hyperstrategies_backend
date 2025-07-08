// server/routes/withdraw.js

const express = require('express');
const { ethers } = require('ethers'); // Correctly imports the full ethers library
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Queue a New Withdrawal Endpoint ---
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { toAddress, amount, token = 'USDC' } = req.body;
    const userId = req.user.id;

    // ✅ THE FIX: Use the correct ethers v6 syntax
    if (!ethers.isAddress(toAddress)) {
      return res.status(400).json({ message: 'Invalid ETH address' });
    }

    const { rows } = await pool.query(`SELECT balance FROM users WHERE user_id = $1`, [userId]);
    const userBalance = parseFloat(rows[0]?.balance || 0);
    const amountFloat = parseFloat(amount);

    if (amountFloat > userBalance) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    await pool.query(
      `INSERT INTO withdrawal_queue (user_id, to_address, amount, token)
       VALUES ($1, $2, $3, $4)`,
      [userId, toAddress, amountFloat, token.toUpperCase()]
    );

    console.log(`📥 Queued withdrawal for user ${userId} to ${toAddress} for ${amount} ${token}`);

    return res.status(200).json({
      status: 'queued',
      message: 'Withdrawal has been queued for processing.'
    });

  } catch (err) {
    console.error('Queue insert error:', err);
    return res.status(500).json({ message: 'Failed to queue withdrawal' });
  }
});


// --- Get User's Withdrawal History Endpoint ---
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // This query now includes the 'error_message' column for better UX
    const query = `
      SELECT id, amount, token, to_address, status, created_at, tx_hash, error_message
      FROM withdrawal_queue WHERE user_id = $1
      UNION ALL
      SELECT id, amount, token, to_address, 'Sent' as status, created_at, tx_hash, NULL as error_message
      FROM withdrawals WHERE user_id = $1
      ORDER BY created_at DESC
    `;

    const historyResult = await pool.query(query, [userId]);

    res.json(historyResult.rows);

  } catch (err) {
    console.error('Error fetching withdrawal history:', err.message);
    res.status(500).send('Server Error');
  }
});


module.exports = router;