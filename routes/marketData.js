// /routes/marketData.js

const express = require('express');
const router = express.Router();
const pool = require('../db');

/**
 * @route   GET /api/market-data/:vaultId
 * @desc    Get historical performance data for a vault and its key assets.
 *          This data is used for the "Performance Index" chart view, which is
 *          independent of any single user's deposits or withdrawals.
 * @access  Public (or Authenticated, based on your middleware)
 */
router.get('/:vaultId', async (req, res) => {
  const { vaultId } = req.params;
  const days = parseInt(req.query.days, 10) || 30; // Default to 30 days of history

  try {
    // 1. Fetch the raw historical data for the vault from the database.
    const historyResult = await pool.query(
      `SELECT 
         record_date, 
         pnl_percentage, 
         asset_prices_snapshot
       FROM vault_performance_history 
       WHERE vault_id = $1 AND record_date >= NOW() - INTERVAL '${days} days'
       ORDER BY record_date ASC`, // IMPORTANT: Order ascending for chronological processing
      [vaultId]
    );

    if (historyResult.rows.length < 2) {
      return res.status(404).json({ message: 'Insufficient historical data for this period.' });
    }

    const history = historyResult.rows;

    // 2. Process the data to create normalized, chart-ready time series.
    const vaultPerformance = [];
    const assetPerformance = {}; // e.g., { BTC: [], ETH: [] }

    // Use the first data point as the baseline for normalization (so charts start at 0%).
    const basePnl = parseFloat(history[0].pnl_percentage);
    const basePrices = {};

    // Initialize asset arrays and find base prices from the first snapshot
    if (history[0].asset_prices_snapshot) {
      for (const key in history[0].asset_prices_snapshot) {
        const symbol = findSymbolByAddress(key, history[0].asset_prices_snapshot); // A helper we'll need
        if (symbol && ['BTC', 'ETH', 'SOL'].includes(symbol.toUpperCase())) { // Only track major assets for clarity
          assetPerformance[symbol.toUpperCase()] = [];
          basePrices[symbol.toUpperCase()] = history[0].asset_prices_snapshot[key];
        }
      }
    }

    // 3. Iterate through all historical points to build the performance data.
    for (const point of history) {
      const recordDate = point.record_date;

      // A. Calculate Vault Performance (relative to the start of the window)
      const currentPnl = parseFloat(point.pnl_percentage);
      vaultPerformance.push({
        date: recordDate,
        value: currentPnl - basePnl,
      });

      // B. Calculate individual Asset Performance
      if (point.asset_prices_snapshot) {
        for (const symbol in assetPerformance) {
          const address = findAddressBySymbol(symbol, point.asset_prices_snapshot);
          const currentPrice = point.asset_prices_snapshot[address];
          const basePrice = basePrices[symbol];

          if (typeof currentPrice === 'number' && typeof basePrice === 'number' && basePrice > 0) {
            const performancePct = ((currentPrice / basePrice) - 1) * 100;
            assetPerformance[symbol].push({
              date: recordDate,
              value: performancePct,
            });
          }
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


// --- Helper functions to handle the symbol/address mapping in snapshots ---
// NOTE: These are simplified. A more robust solution might query vault_assets table.
const KNOWN_ADDRESSES = {
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'BTC',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
  '0xd31a59c85ae9d8edefec411e448fd2e703a42e99': 'SOL', // Example, replace with actual SOL contract if applicable
};

function findSymbolByAddress(address, snapshot) {
    // This is a placeholder for a more robust lookup.
    // For now, it handles both direct symbols and known addresses.
    if (KNOWN_ADDRESSES[address.toLowerCase()]) {
        return KNOWN_ADDRESSES[address.toLowerCase()];
    }
    // If the key itself is a symbol (legacy data)
    if (['BTC', 'ETH', 'SOL'].includes(address.toUpperCase())) {
        return address.toUpperCase();
    }
    return null;
}

function findAddressBySymbol(symbol, snapshot) {
    for (const address in KNOWN_ADDRESSES) {
        if (KNOWN_ADDRESSES[address].toUpperCase() === symbol.toUpperCase()) {
            return address;
        }
    }
    // Fallback for legacy data where key is the symbol itself
    if (snapshot[symbol.toUpperCase()]) {
      return symbol.toUpperCase();
    }
    return null;
}


module.exports = router;
