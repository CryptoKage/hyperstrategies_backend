// server/routes/withdraw.js

const express = require('express');
const { ethers } = require('ethers'); // This is the correct import for ethers v5
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');

const router = express.Router();

// --- ✅ THE FIX: Use the correct ethers v5 syntax for creating a provider ---
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);

// --- Queue a New Platform Withdrawal Endpoint ---
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { toAddress, amount, token = 'USDC' } = req.body;
    const userId = req.user.id;

    // ✅ THE FIX: Use the correct ethers v5 syntax for address validation
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ message: 'Invalid ETH address' });
    }

    const userWalletResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userWalletResult.rows.length === 0) {
      return res.status(404).json({ message: 'User wallet not found.' });
    }
    const userEthAddress = userWalletResult.rows[0].eth_address;

    const onChainBalance_BN = await usdcContract.balanceOf(userEthAddress);
    // ✅ THE FIX: Use the correct ethers v5 syntax for parsing units
    const withdrawalAmount_BN = ethers.utils.parseUnits(amount.toString(), tokenMap.usdc.decimals);

    if (withdrawalAmount_BN.gt(onChainBalance_BN)) {
      return res.status(400).json({ message: 'Insufficient on-chain USDC balance.' });
    }

    await pool.query(
      `INSERT INTO withdrawal_queue (user_id, to_address, amount, "token")
       VALUES ($1, $2, $3, $4)`,
      [userId, toAddress, amount, token.toUpperCase()]
    );

    console.log(`📥 Queued platform withdrawal for user ${userId} to ${toAddress} for ${amount} ${token}`);

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