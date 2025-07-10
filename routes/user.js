// server/routes/user.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');

const router = express.Router();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, provider);

// --- Get User Wallet Info Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // We now fetch all three pieces of data in parallel
    const [userResult, usdcBalanceBigNumber, bonusPointsResult] = await Promise.all([
      pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]),
      usdcContract.balanceOf(userResult.rows[0].eth_address), // Assuming userResult is fast
      // ✅ NEW: Query for the sum of bonus points
      pool.query('SELECT COALESCE(SUM(points_amount), 0) AS total_bonus_points FROM bonus_points WHERE user_id = $1', [userId])
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    const ethBalanceBigNumber = await provider.getBalance(userAddress);

    const ethBalance = ethers.utils.formatEther(ethBalanceBigNumber);
    const usdcBalance = ethers.utils.formatUnits(usdcBalanceBigNumber, tokenMap.usdc.decimals);
    const totalBonusPoints = parseFloat(bonusPointsResult.rows[0].total_bonus_points);

    res.json({
      address: userAddress,
      ethBalance: parseFloat(ethBalance),
      usdcBalance: parseFloat(usdcBalance),
      totalBonusPoints: totalBonusPoints // ✅ Send the bonus points to the frontend
    });

  } catch (err) {
    console.error('Error fetching wallet data:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;