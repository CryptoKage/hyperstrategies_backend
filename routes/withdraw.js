// server/routes/withdraw.js
const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { decrypt } = require('../utils/walletUtils');
const { getTokenAddress, getUserWallet, getTokenAbi } = require('../utils/withdrawHelpers');

const router = express.Router();

router.post('/confirm', authenticateToken, async (req, res) => {
  const { toAddress, amount, token } = req.body;
  const userId = req.user.id;

  try {
    if (!ethers.utils.isAddress(toAddress)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_URL);
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

module.exports = router;