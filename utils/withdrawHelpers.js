// utils/withdrawHelpers.js
const { ethers } = require('ethers');
const axios = require('axios');

function getTokenAddress(token) {
  const addresses = {
    usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7'
  };
  return addresses[token.toLowerCase()];
}

function getTokenAbi() {
  return [
    "function transfer(address to, uint256 amount) public returns (bool)",
    "function decimals() public view returns (uint8)"
  ];
}

async function getUserWallet(userId) {
  const pool = require('../db');
  const { decrypt } = require('./walletUtils');

  const { rows } = await pool.query(
    `SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1`,
    [userId]
  );

  const user = rows[0];
  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
  const wallet = new ethers.Wallet(decrypt(user.eth_private_key_encrypted), provider);

  return { ...user, wallet };
}

async function getEthUsdPrice() {
  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum',
        vs_currencies: 'usd'
      }
    });
    return data.ethereum.usd;
  } catch (err) {
    console.error('Error fetching ETH price:', err);
    return null;
  }
}

function getTokenAbi() {
  return [
    // ✅ Standard ERC20 methods used in polling
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function transfer(address to, uint amount) returns (bool)"
  ];
}

async function estimateGasForTokenTransfer({ provider, fromAddress, toAddress, tokenAddress, amount }) {
  const tokenAbi = getTokenAbi();
  const contract = new ethers.Contract(tokenAddress, tokenAbi, provider);
  const decimals = await contract.decimals();
  const formattedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

  const gasPrice = await provider.getGasPrice();

  const gasLimit = await contract.estimateGas.transfer(toAddress, formattedAmount, { from: fromAddress });
  const totalGasCost = gasLimit.mul(gasPrice);

  return {
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    totalGasCost
  };
}

module.exports = {
  getTokenAddress,
  getTokenAbi,
  getUserWallet,
  getEthUsdPrice,
  estimateGasForTokenTransfer
};
