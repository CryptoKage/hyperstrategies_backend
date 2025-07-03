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
  console.log("🔥 Received POST /api/withdraw request");

  const { toAddress, amount, token } = req.body;
  const userId = req.user.id;

  try {
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const userWallet = await getUserWallet(userId);
    const decryptedKey = decrypt(userWallet.eth_private_key_encrypted);
    const wallet = new ethers.Wallet(decryptedKey, provider);

    const { rows } = await pool.query(
      `SELECT balance FROM users WHERE user_id = $1`,
      [userId]
    );
    const dbBalance = parseFloat(rows[0].balance);
    const amountFloat = parseFloat(amount);
    if (amountFloat > dbBalance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await sendEthFromHotWalletIfNeeded(userWallet.eth_address, provider);

    const tokenAddress = getTokenAddress(token);
    const tokenAbi = getTokenAbi();
    const contract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

    const decimals = await contract.decimals();
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const txData = contract.interface.encodeFunctionData("transfer", [toAddress, parsedAmount]);

    const tx = {
      to: tokenAddress,
      from: userWallet.eth_address,
      data: txData,
      type: 2,
    };

    let gasLimit;
    try {
      gasLimit = await provider.estimateGas(tx);
    } catch (err) {
      console.warn("⛽ Gas estimation failed, using fallback gas limit.");
      gasLimit = ethers.BigNumber.from("100000"); // fallback
    }

    const gasPrice = await provider.getGasPrice();
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || gasPrice;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('2', 'gwei');

    const txResponse = await wallet.sendTransaction({
      to: tokenAddress,
      data: txData,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas
    });

    await pool.query('BEGIN');

    await pool.query(
      `INSERT INTO withdrawals (user_id, to_address, amount, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, toAddress, amountFloat, txResponse.hash, 'sent']
    );

    await pool.query(
      `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
      [amountFloat, userId]
    );

    await pool.query('COMMIT');

    return res.json({ success: true, txHash: txResponse.hash });

  } catch (err) {
    console.error('Withdraw error:', err);
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Withdrawal failed.' });
  }
});

module.exports = router;
