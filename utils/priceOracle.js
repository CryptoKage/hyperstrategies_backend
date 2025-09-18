// /utils/priceOracle.js

const fetch = require('node-fetch');

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";
// Note: The free CoinGecko API has rate limits. For production, consider a paid plan if usage is high.
const COINGECKO_API_URL = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=";

/**
 * Fetches live prices for a list of vault assets from multiple sources.
 * @param {Array<Object>} assets - An array of asset objects from the vault_assets table.
 *                                 Each object must have { symbol, contract_address, coingecko_id }.
 * @returns {Promise<Map<string, number>>} A promise that resolves to a map of lowercase contract_address -> price.
 */
async function getPrices(assets) {
  const priceMap = new Map();

  // Always price USDC at $1.0
  const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  priceMap.set(usdcAddress, 1.0);

  const assetsToFetch = assets.filter(a => a.contract_address.toLowerCase() !== usdcAddress);
  if (assetsToFetch.length === 0) {
    return priceMap;
  }

  // --- 1. Primary Source: Hyperliquid ---
  const symbolsToFetchHyperliquid = assetsToFetch.map(a => a.symbol.toUpperCase());
  console.log(`[PriceOracle] Attempting to fetch ${symbolsToFetchHyperliquid.length} prices from Hyperliquid...`);
  try {
    const response = await fetch(HYPERLIQUID_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (response.ok) {
      const mids = await response.json();
      for (const asset of assetsToFetch) {
        const priceStr = mids[asset.symbol.toUpperCase()];
        if (priceStr) {
          priceMap.set(asset.contract_address.toLowerCase(), parseFloat(priceStr));
        }
      }
    }
  } catch (err) {
    console.warn('[PriceOracle] Hyperliquid API fetch failed:', err.message);
  }

  // --- 2. Fallback Source: CoinGecko ---
  const assetsMissingPrice = assetsToFetch.filter(a => !priceMap.has(a.contract_address.toLowerCase()));
  if (assetsMissingPrice.length > 0) {
    const coingeckoContracts = assetsMissingPrice
      .filter(a => a.coingecko_id) // Only fetch those with a coingecko_id
      .map(a => a.contract_address)
      .join(',');

    if (coingeckoContracts) {
      console.log(`[PriceOracle] Attempting to fetch ${assetsMissingPrice.length} missing prices from CoinGecko...`);
      try {
        const response = await fetch(`${COINGECKO_API_URL}${coingeckoContracts}&vs_currencies=usd`);
        if (response.ok) {
          const cgPrices = await response.json();
          for (const asset of assetsMissingPrice) {
            const priceData = cgPrices[asset.contract_address.toLowerCase()];
            if (priceData && priceData.usd) {
              priceMap.set(asset.contract_address.toLowerCase(), priceData.usd);
            }
          }
        }
      } catch (err) {
        console.warn('[PriceOracle] CoinGecko API fetch failed:', err.message);
      }
    }
  }

  console.log(`[PriceOracle] Final resolved prices:`, Object.fromEntries(priceMap));
  return priceMap;
}

module.exports = { getPrices };
