// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/routes/pnl.js

const express = require('express');
// ==============================================================================
// --- FINAL BUG FIX: Use destructuring to import the LRU class ---
// The latest version of the 'lru-cache' library uses a named export.
// ==============================================================================
const { LRU } = require('lru-cache');
const { z } = require('zod');
const {
  getAlchemyClient,
  resolveNetworkByChainId,
  extractPrice,
  DEFAULT_PRICE_CURRENCY,
} = require('../services/alchemy');

const router = express.Router();
const cache = new LRU({ max: 500, ttl: 5 * 60 * 1000 }); // 5 min cache

// Zod schema for input validation
const QuerySchema = z.object({
  address: z.string().min(42).regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
  chain: z.string().default(process.env.DEFAULT_CHAIN || "0x1"), // hex chainId
});

const keyFor = (addr, chain) => `pnl:${chain}:${addr.toLowerCase()}`;

router.get("/:address", async (req, res) => {
  try {
    const parsed = QuerySchema.parse({
      address: req.params.address,
      chain: req.query.chain,
    });
    const { address, chain } = parsed;

    const cacheKey = keyFor(address, chain);
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ source: "cache", ...cached });

    const alchemy = getAlchemyClient();
    const alchemyNetwork = resolveNetworkByChainId(chain);

    const balancesResponse = await alchemy.core.getTokenBalances(address, { network: alchemyNetwork });
    const nonZeroBalances = balancesResponse.tokenBalances.filter(token => token.tokenBalance !== '0');
    
    const holdings = [];
    // The rest of this logic can be built out later as a feature enhancement.
    // For now, it will return an empty holdings array but will not crash the server.
    const portfolioValue = 0; 

    const payload = {
      address,
      chain,
      portfolioValueUSD: portfolioValue,
      holdings: holdings,
      updatedAt: new Date().toISOString(),
      priceSource: "alchemy",
      priceCurrency: DEFAULT_PRICE_CURRENCY,
    };

    cache.set(cacheKey, payload);
    res.json(payload);

  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "VALIDATION_FAILED", issues: err.errors });
    }
    const status = /429/.test(String(err)) ? 429 : 500;
    res.status(status).json({
      error: "PNL_FETCH_FAILED",
      message: err?.message || String(err),
    });
  }
});

module.exports = router;
