// server/routes/withdraw.js
const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// Queue the withdrawal request
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { toAddress, amount, token = 'usdc' } = req.body;
    const userId = req.user.id;

    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid ETH address' });
    }

    // Check balance
    const { rows } = await pool.query(`SELECT balance FROM users WHERE user_id = $1`, [userId]);
    const userBalance = parseFloat(rows[0]?.balance || 0);
    const amountFloat = parseFloat(amount);

    if (amountFloat > userBalance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Insert into queue
    await pool.query(
      `INSERT INTO withdrawal_queue (user_id, to_address, amount, token)
       VALUES ($1, $2, $3, $4)`,
      [userId, toAddress, amount, token]
    );

    console.log(`📥 Queued withdrawal for user ${userId} to ${toAddress} for ${amount} ${token}`);

    return res.status(200).json({
      status: 'queued',
      message: 'Withdrawal has been queued for processing.'
    });

  } catch (err) {
    console.error('Queue insert error:', err);
    return res.status(500).json({ error: 'Failed to queue withdrawal' });
  }
});

module.exports = router;
