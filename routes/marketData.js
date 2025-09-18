// /routes/marketData.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment');

const KNOWN_ASSETS_TO_TRACK = ['BTC', 'ETH', 'SOL'];
const KNOWN_ADDRESSES = {
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'BTC',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
  '0xd31a59c85ae9d8edefec411e448fd2e703a42e99': 'SOL',
};
const SYMBOL_TO_ADDRESS = Object.fromEntries(Object.entries(KNOWN_ADDRESSES).map(([addr, sym]) => [sym, addr]));

router.get('/:vaultId', async (req, res) => {
  const { vaultId } = req.params;
  const days = parseInt(req.query.days, 10) || 365;

  try {
    const [indexHistoryResult, assetHistoryResult] = await Promise.all([
      pool.query(
        `SELECT record_date, index_value
         FROM vault_performance_index 
         WHERE vault_id = $1 AND record_date >= NOW() - INTERVAL '${days} days'
         ORDER BY record_date ASC`,
        [vaultId]
      ),
      pool.query(
        `SELECT record_date, asset_prices_snapshot
         FROM vault_performance_history 
         WHERE vault_id = $1 AND record_date >= NOW() - INTERVAL '${days} days'
         ORDER BY record_date ASC`,
        [vaultId]
      )
    ]);

    if (indexHistoryResult.rows.length < 2) {
      return res.json({ vaultPerformance: [], assetPerformance: {} });
    }

    const indexHistory = indexHistoryResult.rows;
    const assetHistory = assetHistoryResult.rows;

    // --- Process Vault Performance Index ---
    const baseIndexValue = parseFloat(indexHistory[0].index_value);
    const vaultPerformance = indexHistory.map(point => ({
      date: point.record_date,
      value: ((parseFloat(point.index_value) / baseIndexValue) - 1) * 100,
    }));

    // --- Process Asset Performance ---
    const assetPerformance = {};
    if (assetHistory.length > 0) {
        const basePrices = {};
        const firstValidSnapshot = assetHistory.find(p => p.asset_prices_snapshot);

        if(firstValidSnapshot) {
            for (const symbol of KNOWN_ASSETS_TO_TRACK) {
                const address = SYMBOL_TO_ADDRESS[symbol];
                if (firstValidSnapshot.asset_prices_snapshot[address]) {
                    basePrices[symbol] = parseFloat(firstValidSnapshot.asset_prices_snapshot[address]);
                }
            }
        }
        
        for (const symbol of KNOWN_ASSETS_TO_TRACK) {
            assetPerformance[symbol] = [];
            const basePrice = basePrices[symbol];
            if (basePrice > 0) {
                assetHistory.forEach(point => {
                    if (point.asset_prices_snapshot) {
                        const address = SYMBOL_TO_ADDRESS[symbol];
                        const currentPrice = parseFloat(point.asset_prices_snapshot[address]);
                        if (!isNaN(currentPrice)) {
                            assetPerformance[symbol].push({
                                date: point.record_date,
                                value: ((currentPrice / basePrice) - 1) * 100,
                            });
                        }
                    }
                });
            }
        }
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
