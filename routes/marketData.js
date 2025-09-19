// /routes/marketData.js

const express = require('express');
const router = express.Router();
const pool = require('../db');

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

    res.json({
      vaultPerformance: indexHistoryResult.rows,
      assetPerformance: assetHistoryResult.rows, // Send the raw array of history rows
    });

  } catch (error) {
    console.error(`Error fetching market performance for Vault ${vaultId}:`, error);
    res.status(500).json({ error: 'Failed to fetch market performance data.' });
  }
});

module.exports = router;
