// server/routes/user.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');

const router = express.Router();

// Your Alchemy provider setup
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

// --- ✅ THIS IS THE FIX ---
// This is the minimal, correct ABI for any standard ERC20 token to check a balance.
// It explicitly defines the 'balanceOf' function that ethers needs.
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)"
];

// Get the USDC contract info from your tokenMap
const usdcInfo = tokenMap.usdc;
const usdcContractAddress = usdcInfo.address;

// Create the contract instance using the correct, minimal ABI
const usdcContract = new ethers.Contract(usdcContractAddress, erc20Abi, provider);


// --- Get User Wallet Info Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    // This part of the code will now work correctly
    const [ethBalanceBigNumber, usdcBalanceBigNumber] = await Promise.all([
      provider.getBalance(userAddress),
      usdcContract.balanceOf(userAddress) // The function will now be found
    ]);

    const ethBalance = ethers.utils.formatEther(ethBalanceBigNumber);
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