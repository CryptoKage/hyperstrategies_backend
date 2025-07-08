// server/routes/withdraw.js
const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Queue a New Withdrawal Endpoint ---
// Your existing code - this is correct.
router.post('/', authenticateToken, async (req, res) => {
  try {
    // Note: The frontend sends 'toAddress', but your code expects it as 'to_address' in the queue.
    // It's good practice to align these. Let's handle it here for now.
    const { toAddress, amount, token = 'USDC' } = req.body;
    const userId = req.user.id;

    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ message: 'Invalid ETH address' });
    }

    // Check balance
    // This correctly checks the user's main 'balance' column.
    const { rows } = await pool.query(`SELECT balance FROM users WHERE user_id = $1`, [userId]);
    const userBalance = parseFloat(rows[0]?.balance || 0);
    const amountFloat = parseFloat(amount);

    if (amountFloat > userBalance) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Insert into queue
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


// --- ✅ ADDED: Get User's Withdrawal History Endpoint ---
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // This query gets records from both the queue and the final 'withdrawals' table,
    // combines them, and orders them by most recent first.
    const query = `
      (SELECT 
        id, 
        amount, 
        token, 
        to_address, 
        status, 
        created_at,
        tx_hash
      FROM withdrawal_queue WHERE user_id = $1)
      UNION ALL
      (SELECT 
        id, 
        amount, 
        token, 
        to_address, 
        'Sent' as status, -- We hardcode the status for completed withdrawals
        created_at,
        tx_hash
      FROM withdrawals WHERE user_id = $1)
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