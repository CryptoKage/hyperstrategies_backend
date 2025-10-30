// server/routes/withdraw.js

const express = require('express');
const { ethers } = require('ethers'); // This is the correct import for ethers v5
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');
const { ok, fail } = require('../utils/response');

const router = express.Router();

// --- ✅ THE FIX: Use the correct ethers v5 syntax for creating a provider ---
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];

// --- Queue a New Platform Withdrawal Endpoint ---
router.post('/', authenticateToken, async (req, res) => {
  const { toAddress, amount, token = 'USDC' } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json(fail('INVALID_ADDRESS'));
    }
    const validatedAmount = parseFloat(amount);
    if (isNaN(validatedAmount) || validatedAmount <= 0) {
      return res.status(400).json(fail('INVALID_AMOUNT'));
    }
    const tokenInfo = tokenMap[token.toLowerCase()];
    if (!tokenInfo) {
      return res.status(400).json(fail('UNSUPPORTED_TOKEN'));
    }

    await client.query('BEGIN');

    const userResult = await client.query('SELECT balance FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json(fail('USER_NOT_FOUND'));
    }
    const currentBalance = parseFloat(userResult.rows[0].balance);

    if (currentBalance < validatedAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json(fail('INSUFFICIENT_FUNDS'));
    }

    const newBalance = currentBalance - validatedAmount;
    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [newBalance, userId]);

    await client.query(
      `INSERT INTO withdrawal_queue (user_id, to_address, amount, "token")
       VALUES ($1, $2, $3, $4)`,
      [userId, toAddress, validatedAmount, tokenInfo.symbol]
    );
    
    await client.query('COMMIT');

    console.log(`📥 Queued platform withdrawal for user ${userId}. Balance debited by ${validatedAmount}.`);
    
    // Return standardized success response
    return res.status(200).json(ok('WITHDRAWAL_QUEUED'));

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Queue insert error:', err);
    // Return standardized generic error
    return res.status(500).json(fail('GENERIC_SERVER_ERROR'));
  } finally {
    if (client) client.release();
  }
});

// --- Get User's Withdrawal History Endpoint ---
// This is the complete and correct history route.
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const query = `
      SELECT id::text, amount, "token", to_address, status, created_at, tx_hash, error_message
      FROM withdrawal_queue WHERE user_id = $1
      UNION ALL
      SELECT id::text, amount, "token", to_address, status, created_at, tx_hash, NULL as error_message
      FROM withdrawals WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const historyResult = await pool.query(query, [userId]);
    res.json(historyResult.rows);
  } catch (err) {
    console.error('Error fetching withdrawal history:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
//comment
