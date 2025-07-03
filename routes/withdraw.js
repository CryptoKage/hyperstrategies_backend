const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { decrypt } = require('../utils/walletUtils');
const {
  getTokenAddress,
  getUserWallet,
  getTokenAbi
} = require('../utils/withdrawHelpers');
const { sendEthFromHotWalletIfNeeded } = require('../utils/ethGasFunding');

const router = express.Router();

// Confirm Route (Estimate Gas)
router.post('/confirm', authenticateToken, async (req, res) => {
  const { toAddress, amount, token } = req.body;
  const userId = req.user.id;

  try {
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = await getUserWallet(userId);
    const tokenAddress = getTokenAddress(token);
    const tokenAbi = getTokenAbi();
    const contract = new ethers.Contract(tokenAddress, tokenAbi, provider);

    const decimals = await contract.decimals();
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const gasEstimate = await contract.estimateGas.transfer(toAddress, parsedAmount, {
      from: userWallet.eth_address
    });

    const gasPrice = await provider.getGasPrice();
    const gasCost = gasEstimate.mul(gasPrice);

    return res.json({
      estimatedGasEth: ethers.utils.formatEther(gasCost),
      estimatedGasUsd: 'N/A (implement pricing later)',
      gasLimit: gasEstimate.toString(),
      gasPrice: gasPrice.toString(),
    });

  } catch (err) {
    console.error('Gas Estimation Error:', err);
    return res.status(500).json({ error: 'Failed to estimate gas.' });
  }
});

// Withdraw Route
router.post('/', authenticateToken, async (req, res) => {
  console.log("🔥 Received POST /api/withdraw request");
  try {
    const { amount, toAddress, token = 'eth' } = req.body;
    const userId = req.user.id;

    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid ETH address' });
    }

    const { rows } = await pool.query(
      `SELECT eth_address, eth_private_key_encrypted, balance FROM users WHERE user_id = $1`,
      [userId]
    );

    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ethAddress = user.eth_address;
    const decryptedKey = decrypt(user.eth_private_key_encrypted);
    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const wallet = new ethers.Wallet(decryptedKey, provider);

    const amountFloat = parseFloat(amount);
    if (amountFloat > user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // ✅ TOP-UP ETH FOR GAS IF NEEDED
    await sendEthFromHotWalletIfNeeded(userId, ethAddress);

    let tx;
    if (token === 'eth') {
      tx = await wallet.sendTransaction({
        to: toAddress,
        value: ethers.utils.parseEther(amount.toString())
      });
    } else {
      const tokenAddress = getTokenAddress(token);
      const tokenAbi = getTokenAbi();
      const contract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

      const decimals = await contract.decimals();
      const formattedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

      tx = await contract.transfer(toAddress, formattedAmount);
    }

    await pool.query('BEGIN');

    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, token, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, toAddress, amountFloat, token, tx.hash, 'sent']
    );

    await pool.query(
      `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
      [amountFloat, userId]
    );

    await pool.query('COMMIT');

    res.json({ success: true, txHash: tx.hash });

  } catch (err) {
    console.error('Withdraw error:', err);
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

module.exports = router;
