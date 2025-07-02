// utils/gas/estimate.js

const { ethers } = require("ethers");
const tokenMap = require("../tokens/tokenMap");
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

const provider = new ethers.providers.AlchemyProvider("homestead", ALCHEMY_API_KEY);

/**
 * Estimate the gas cost (in ETH and USD) for a token transfer.
 * @param {string} tokenSymbol - Token symbol (e.g. 'USDC', 'USDT')
 * @param {string} from - Sender address
 * @param {string} to - Recipient address
 * @param {string} amount - Amount to send (in token decimals)
 * @returns {Promise<{ethCost: string, usdCost: string}>}
 */
async function estimateTokenTransferGas(tokenSymbol, from, to, amount) {
  try {
    const token = tokenMap[tokenSymbol];
    if (!token) throw new Error("Unsupported token");

    const contract = new ethers.Contract(token.address, token.abi, provider);

    const txRequest = await contract.populateTransaction.transfer(to, ethers.utils.parseUnits(amount, token.decimals));

    txRequest.from = from;

    const gasEstimate = await provider.estimateGas(txRequest);
    const gasPrice = await provider.getGasPrice();

    const ethCost = gasEstimate.mul(gasPrice);
    const ethCostFormatted = ethers.utils.formatEther(ethCost);

    // ETH price in USD - can also be cached to avoid API spam
    const ethPrice = await getEthPriceUSD();
    const usdCost = (parseFloat(ethCostFormatted) * ethPrice).toFixed(2);

    return {
      ethCost: ethCostFormatted,
      usdCost,
    };
  } catch (err) {
    console.error("Gas estimate failed:", err);
    throw err;
  }
}

// Fetch ETH price from Coingecko (or other API)
async function getEthPriceUSD() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  const data = await res.json();
  return data.ethereum.usd;
}

module.exports = estimateTokenTransferGas;