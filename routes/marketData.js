// /routes/marketData.js

const express = require('express');
const router = express.Router();
const pool = require('../db');

const KNOWN_ASSETS_TO_TRACK = ['BTC', 'ETH', 'SOL'];
const KNOWN_ADDRESSES = {
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'BTC',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
  '0xd31a59c85ae9d8edefec411e448fd2e703a42e99': 'SOL',
};

// A reverse map for quick lookups
const SYMBOL_TO_ADDRESS = Object.entries(KNOWN_ADDRESSES).reduce((acc, [addr, sym]) => {
  acc[sym] = addr;
  return acc;
}, {});


router.get('/:vaultId', async (req, res) => {
  const { vaultId } = req.params;
  const days = parseInt(req.query.days, 10) || 30;

  try {
    const historyResult = await pool.query(
      `SELECT 
         record_date, 
         total_value_locked,
         asset_prices_snapshot
       FROM vault_performance_history 
       WHERE vault_id = $1 AND record_date >= NOW() - INTERVAL '${days} days'
       ORDER BY record_date ASC`,
      [vaultId]
    );

    if (historyResult.rows.length < 2) {
      return res.status(200).json({ vaultPerformance: [], assetPerformance: {} });
    }

    const history = historyResult.rows;
    const combinedData = [];

    // --- Baselines are taken from the very first data point in the window ---
    const baseNav = parseFloat(history[0].total_value_locked);
    const basePrices = {};

    for (const symbol of KNOWN_ASSETS_TO_TRACK) {
      const address = SYMBOL_TO_ADDRESS[symbol];
      if (history[0].asset_prices_snapshot && history[0].asset_prices_snapshot[address]) {
        basePrices[symbol] = parseFloat(history[0].asset_prices_snapshot[address]);
      } else if (history[0].asset_prices_snapshot && history[0].asset_prices_snapshot[symbol]) {
        // Handle legacy format
        basePrices[symbol] = parseFloat(history[0].asset_prices_snapshot[symbol]);
      }
    }

    // --- Iterate through ALL historical points to build a complete dataset ---
    for (const point of history) {
      const date = new Date(point.date || point.record_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const record = { date };

      // 1. Calculate Vault Performance based on NAV growth (THE FIX for the -1700% drop)
      const currentNav = parseFloat(point.total_value_locked);
      if (baseNav > 0) {
        record.VAULT = ((currentNav / baseNav) - 1) * 100;
      }

      // 2. Calculate Asset Performance for each tracked asset (THE FIX for the dotted lines)
      if (point.asset_prices_snapshot) {
        for (const symbol of KNOWN_ASSETS_TO_TRACK) {
          const basePrice = basePrices[symbol];
          if (basePrice > 0) {
            const address = SYMBOL_TO_ADDRESS[symbol];
            let currentPrice = null;
            if (point.asset_prices_snapshot[address]) {
              currentPrice = parseFloat(point.asset_prices_snapshot[address]);
            } else if (point.asset_prices_snapshot[symbol]) { // Legacy fallback
              currentPrice = parseFloat(point.asset_prices_snapshot[symbol]);
            }

            if (currentPrice !== null) {
              record[symbol] = ((currentPrice / basePrice) - 1) * 100;
            }
          }
        }
      }
      combinedData.push(record);
    }
    
    // The frontend expects this structure, but we'll send it pre-formatted to be safe.
    // The previous frontend code for `formatChartData` will handle this perfectly.
    const vaultPerformance = combinedData.map(p => ({ date: p.date, value: p.VAULT }));
    const assetPerformance = {};
    for (const symbol of KNOWN_ASSETS_TO_TRACK) {
        assetPerformance[symbol] = combinedData.map(p => ({ date: p.date, value: p[symbol] })).filter(p => p.value !== undefined);
    }

    res.json({
      vaultPerformance,
      assetPerformance,
    });

  } catch (error) {
    console.error(`Error fetching market performance for Vault ${vaultId}:`, error);
    res.status(500).json({ error: 'Failed to fetch market performance data.' });
  }
});

module.exports = router;
