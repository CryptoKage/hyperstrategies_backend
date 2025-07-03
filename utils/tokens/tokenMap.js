// utils/tokens/tokenMap.js

const usdcAbi = require('./usdcAbi.json');

const tokenMap = {
  usdc: {
    symbol: 'USDC',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    abi: usdcAbi
  },
  usdt: {
    symbol: 'USDT',
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    abi: usdcAbi // temporarily reuse until USDT ABI added
  }
};

module.exports = tokenMap;
