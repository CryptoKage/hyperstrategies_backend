// utils/gas/estimateTokenTransferGas.js

const { ethers } = require("ethers");
const tokenMap = require("../tokens/tokenMap");
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

const provider = new ethers.providers.AlchemyProvider("homestead", ALCHEMY_API_KEY);

/**
 * Estimate gas cost for ERC20 transfer with buffer.
 * @param {string} tokenSymbol - Token symbol (e.g. 'USDC')
 * @param {string} from - Sender address
 * @param {string} to - Recipient address
 * @param {string|number} amount - Amount (in human-readable format)
 * @param {number} bufferPercent - Optional % buffer to add (default 5)
 * @returns {Promise<{requiredEth: BigNumber, requiredEthFormatted: string, usdCost: string, gasLimit: BigNumber, gasPrice: BigNumber}>}
 */
async function estimateTokenTransferGas(tokenSymbol, from, to, amount, bufferPercent = 5) {
  try {
    const token = tokenMap[tokenSymbol];
    if (!token) throw new Error("Unsupported token");

    const contract = new ethers.Contract(token.address, token.abi, provider);
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), token.decimals);

    const txRequest = await contract.populateTransaction.transfer(to, parsedAmount);
    txRequest.from = from;

    const gasLimit = await provider.estimateGas(txRequest);
    const gasPrice = await provider.getGasPrice();

    const baseGasCost = gasLimit.mul(gasPrice);

    const bufferedCost = baseGasCost.mul(100 + bufferPercent).div(100);
    const requiredEthFormatted = ethers.utils.formatEther(bufferedCost);

    const ethPrice = await getEthPriceUSD();
    const usdCost = (parseFloat(requiredEthFormatted) * ethPrice).toFixed(2);

    return {
      requiredEth: bufferedCost,
      requiredEthFormatted,
      usdCost,
      gasLimit,
      gasPrice,
    };
  } catch (err) {
    console.error("Gas estimation failed:", err);
    throw err;
  }
}

// Get ETH price in USD
async function getEthPriceUSD() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  const data = await res.json();
  return data.ethereum.usd;
}

module.exports = estimateTokenTransferGas;
