// server/routes/user.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap'); // ✅ 1. Import your tokenMap

const router = express.Router();

// Get the USDC contract info from your tokenMap
const usdcInfo = tokenMap.usdc;
const usdcContractAddress = usdcInfo.address;
const usdcAbi = usdcInfo.abi;

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const usdcContract = new ethers.Contract(usdcContractAddress, usdcAbi, provider);

// --- Get User Wallet Info Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    const [ethBalanceBigNumber, usdcBalanceBigNumber] = await Promise.all([
      provider.getBalance(userAddress),
      usdcContract.balanceOf(userAddress)
    ]);

    const ethBalance = ethers.utils.formatEther(ethBalanceBigNumber);
    // Use the decimals from your tokenMap for accuracy
    const usdcBalance = ethers.utils.formatUnits(usdcBalanceBigNumber, usdcInfo.decimals);

    res.json({
      address: userAddress,
      ethBalance: parseFloat(ethBalance),
      usdcBalance: parseFloat(usdcBalance)
    });

  } catch (err) {
    console.error('Error fetching wallet data:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;