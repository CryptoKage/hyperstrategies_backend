// /utils/priceOracle.js

const fetch = require('node-fetch');

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";
const COINGECKO_API_URL = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=";

// --- THE CACHING LOGIC ---
let priceCache = new Map();
let lastCacheTime = 0;
const CACHE_DURATION_MS = 3 * 60 * 1000; // 3 minutes
// --- END OF CACHING LOGIC ---

async function getPrices(assets) {
    const now = Date.now();

    // --- THE FIX: Check the cache first ---
    if (now - lastCacheTime < CACHE_DURATION_MS && priceCache.size > 0) {
        console.log('[PriceOracle] Returning fast, cached prices.');
        return priceCache;
    }
    // --- END OF FIX ---

    console.log('[PriceOracle] Cache is stale or empty. Fetching fresh prices...');
    const newPriceMap = new Map();
    newPriceMap.set('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 1.0); // USDC

    const assetsToFetch = assets.filter(a => a.contract_address?.toLowerCase() !== '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    // 1. Primary Source: Hyperliquid
    try {
        const response = await fetch(HYPERLIQUID_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: "allMids" }) });
        if (response.ok) {
            const mids = await response.json();
            for (const asset of assetsToFetch) {
                if (asset.contract_address) {
                    const priceStr = mids[asset.symbol.toUpperCase()];
                    if (priceStr) {
                        newPriceMap.set(asset.contract_address.toLowerCase(), parseFloat(priceStr));
                    }
                }
            }
        }
    } catch (err) { console.warn('[PriceOracle] Hyperliquid fetch failed:', err.message); }

    // 2. Fallback Source: CoinGecko
    const assetsMissingPrice = assetsToFetch.filter(a => a.contract_address && !newPriceMap.has(a.contract_address.toLowerCase()));
    if (assetsMissingPrice.length > 0) {
        const coingeckoContracts = assetsMissingPrice.map(a => a.contract_address).join(',');
        try {
            const response = await fetch(`${COINGECKO_API_URL}${coingeckoContracts}&vs_currencies=usd`);
            if (response.ok) {
                const cgPrices = await response.json();
                for (const asset of assetsMissingPrice) {
                    const priceData = cgPrices[asset.contract_address.toLowerCase()];
                    if (priceData && priceData.usd) {
                        newPriceMap.set(asset.contract_address.toLowerCase(), priceData.usd);
                    }
                }
            }
        } catch (err) { console.warn('[PriceOracle] CoinGecko fetch failed:', err.message); }
    }

    // --- THE FIX: Update the cache ---
    priceCache = newPriceMap;
    lastCacheTime = now;
    // --- END OF FIX ---
    
    console.log('[PriceOracle] Fresh prices fetched and cache updated.');
    return priceCache;
}

module.exports = { getPrices };
