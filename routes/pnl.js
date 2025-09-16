// routes/pnl.js
import express from "express";
import { ensureMoralis } from "../services/moralis.js";
import LRU from "lru-cache";
import { z } from "zod";

const router = express.Router();
const cache = new LRU({ max: 500, ttl: 5 * 60 * 1000 }); // 5 min cache

const Query = z.object({
  address: z.string().min(4),
  chain: z.string().default(process.env.DEFAULT_CHAIN || "0x1"), // hex chainId
});

const keyFor = (addr, chain) => `pnl:${chain}:${addr.toLowerCase()}`;

router.get("/:address", async (req, res) => {
  try {
    const parsed = Query.parse({
      address: req.params.address,
      chain: req.query.chain,
    });
    const { address, chain } = parsed;

    const k = keyFor(address, chain);
    const cached = cache.get(k);
    if (cached) return res.json({ source: "cache", ...cached });

    const Moralis = await ensureMoralis();

    // 1) balances
    const balances = await Moralis.EvmApi.balance.getWalletTokenBalances({
      address,
      chain,
    });

    // 2) transactions (optional; useful for realized PnL)
    const txs = await Moralis.EvmApi.transaction.getWalletTransactions({
      address,
      chain,
    });

    // 3) spot prices per token
    const lines = [];
    for (const b of balances?.result || []) {
      const token = b.token || {};
      const priceResp = await Moralis.EvmApi.token.getTokenPrice({
        address: token.contractAddress,
        chain,
      });
      const price = priceResp?.result?.usdPrice || 0;
      const qty = Number(b.balanceFormatted ?? b.balance) || 0;
      lines.push({
        symbol: token.symbol,
        address: token.contractAddress,
        qty,
        price,
        value: qty * price,
        decimals: token.decimals,
      });
    }

    const portfolioValue = lines.reduce((a, x) => a + x.value, 0);

    const payload = {
      address,
      chain,
      portfolioValueUSD: portfolioValue,
      holdings: lines.sort((a, b) => b.value - a.value),
      txCount: txs?.result?.length ?? 0,
      updatedAt: new Date().toISOString(),
    };

    cache.set(k, payload);
    res.json(payload);
  } catch (err) {
    const status = /429/.test(String(err)) ? 429 : 400;
    res.status(status).json({
      error: "PNL_FETCH_FAILED",
      message: err?.message || String(err),
    });
  }
});

export default router;
