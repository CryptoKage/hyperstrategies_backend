// server/routes/withdraw.js
const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { decrypt } = require('../utils/walletUtils');
const { getTokenAddress, getUserWallet, getTokenAbi } = require('../utils/withdrawHelpers');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
  console.log('🔥 Received POST /api/withdraw request');
  const { toAddress, amount, token } = req.body;
  const userId = req.user.id;

  try {
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const { eth_address, eth_private_key_encrypted, balance } = (
      await pool.query(
        'SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1',
        [userId]
      )
    ).rows[0];

    const decryptedPrivateKey = decrypt(eth_private_key_encrypted);
    const userWallet = new ethers.Wallet(decryptedPrivateKey, provider);

    const floatAmount = parseFloat(amount);
    if (floatAmount > parseFloat(balance)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    if (token === 'eth') {
      const tx = await userWallet.sendTransaction({
        to: toAddress,
        value: ethers.utils.parseEther(amount.toString())
      });

      // Update DB
      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO withdrawals (user_id, to_address, amount, tx_hash, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, toAddress, floatAmount, tx.hash, 'sent']
      );
      await pool.query(
        `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
        [floatAmount, userId]
      );
      await pool.query('COMMIT');

      return res.json({ success: true, txHash: tx.hash });
    }

    // Token withdrawal
    const tokenAddress = getTokenAddress(token);
    const tokenAbi = getTokenAbi();
    const contract = new ethers.Contract(tokenAddress, tokenAbi, userWallet);

    const decimals = await contract.decimals();
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    // Ensure ETH is available for gas
    await sendEthFromHotWalletIfNeeded(provider, eth_address);

    const tx = await contract.transfer(toAddress, parsedAmount);

    // Update DB
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, toAddress, floatAmount, token, tx.hash, 'sent']
    );
    await pool.query(
      `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
      [floatAmount, userId]
    );
    await pool.query('COMMIT');

    return res.json({ success: true, txHash: tx.hash });

  } catch (err) {
    console.error('Withdraw error:', err);
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

module.exports = router;
