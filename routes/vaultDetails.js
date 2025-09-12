// vaultdetails.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

// This endpoint gathers all data needed for a single vault's detail page.
router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  const userId = req.user.id;

  try {
    // We will run all necessary queries in parallel for maximum performance.
    const [
      vaultInfoResult,
      userPositionResult,
      performanceHistoryResult,
      assetBreakdownResult,
      userLedgerResult
    ] = await Promise.all([
      // Query 1: Get general vault information
      pool.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      
      // Query 2: Get the user's specific investment totals for this vault
      pool.query(
        `SELECT
           COALESCE(SUM(amount), 0) as total_capital,
           COALESCE(SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END), 0) as total_pnl
         FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2`,
        [userId, vaultId]
      ),

      // Query 3: Get the last 30 days of performance data for the chart
      pool.query(
        `SELECT record_date, pnl_percentage 
         FROM vault_performance_history 
         WHERE vault_id = $1 
         ORDER BY record_date DESC 
         LIMIT 30`,
        [vaultId]
      ),

      // Query 4: Get the current asset breakdown for the portfolio weights display
      pool.query('SELECT symbol, weight FROM vault_assets WHERE vault_id = $1', [vaultId]),
      
      // Query 5: Get the user's detailed transaction history for this vault
      pool.query(
        `SELECT entry_id, entry_type, amount, created_at, status 
         FROM vault_ledger_entries 
         WHERE user_id = $1 AND vault_id = $2 
         ORDER BY created_at DESC`,
        [userId, vaultId]
      )
    ]);

    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found.' });
    }

    // Assemble the final, clean JSON response for the frontend
    const responsePayload = {
      vaultInfo: vaultInfoResult.rows[0],
      userPosition: {
        totalCapital: parseFloat(userPositionResult.rows[0].total_capital),
        totalPnl: parseFloat(userPositionResult.rows[0].total_pnl)
      },
      performanceHistory: performanceHistoryResult.rows,
      assetBreakdown: assetBreakdownResult.rows,
      userLedger: userLedgerResult.rows
    };
    
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  }
});

module.exports = router;
