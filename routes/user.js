// server/routes/user.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// Your Alchemy provider setup
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
// The ABI for a standard ERC20 token's balanceOf function
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
// The address of the USDC contract on your chosen network (e.g., Sepolia)
const usdcContractAddress = process.env.USDC_CONTRACT_ADDRESS; // Add this to your .env file!

const usdcContract = new ethers.Contract(usdcContractAddress, erc20Abi, provider);

// --- Get User Wallet Info Endpoint ---
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get user's ETH address from our database
    const userResult = await pool.query('SELECT eth_address FROM users WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    const userAddress = userResult.rows[0].eth_address;

    // 2. Get ETH and USDC balances directly from the blockchain
    const [ethBalanceBigNumber, usdcBalanceBigNumber] = await Promise.all([
      provider.getBalance(userAddress),
      usdcContract.balanceOf(userAddress)
    ]);

    // 3. Format the balances from Wei/Mwei into readable strings
    const ethBalance = ethers.utils.formatEther(ethBalanceBigNumber);
    const usdcBalance = ethers.utils.formatUnits(usdcBalanceBigNumber, 6); // USDC has 6 decimal places

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