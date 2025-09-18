// /routes/vaultDetails.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { getPrices } = require('../utils/priceOracle');

// This endpoint is now admin-aware.
router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  
  // --- ADMIN VIEW AS LOGIC ---
  // Default to the authenticated user's ID.
  let targetUserId = req.user.id; 
  // If the requester is an admin AND they provide a userId query parameter,
  // we override the targetUserId to "view as" that user.
  if (req.user.isAdmin && req.query.userId) {
    targetUserId = req.query.userId;
    console.log(`[Admin View] Admin ${req.user.id} is viewing vault ${vaultId} as user ${targetUserId}`);
  }
  // --- END OF LOGIC ---

  const client = await pool.connect();

  try {
    const [
      vaultInfoResult,
      assetBreakdownResult,
      openTradesResult,
      // --- THE FIX: Use targetUserId to fetch the correct user's data ---
      userLedgerResult,
      vaultLedgerStatsResult
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      client.query('SELECT symbol, contract_address, chain, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [targetUserId, vaultId]),
      client.query(`SELECT COALESCE(SUM(amount), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId])
    ]);
    // --- END OF FIX ---

    // ... (The rest of the file's logic for calculating userPosition, etc., remains exactly the same)
    if (vaultInfoResult.rows.length === 0) { /* ... error handling ... */ }
    const vaultInfo = vaultInfoResult.rows[0];
    const vaultAssets = assetBreakdownResult.rows;
    const openTrades = openTradesResult.rows;
    const userLedgerEntries = userLedgerResult.rows;
    const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);
    const priceMap = await getPrices(vaultAssets);
    const assetBreakdownWithPrices = vaultAssets.map(asset => ({...asset, livePrice: priceMap.get(asset.contract_address.toLowerCase()) || null,}));
    let userPosition = null;
    if (userLedgerEntries.length > 0) {
      const userPrincipal = userLedgerEntries.filter(e => e.entry_type === 'DEPOSIT').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      const realizedPnl = userLedgerEntries.filter(e => e.entry_type === 'PNL_DISTRIBUTION').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      let totalUnrealizedPnl = 0;
      for (const trade of openTrades) {
        if (trade.contract_address) {
          const currentPrice = priceMap.get(trade.contract_address.toLowerCase());
          if (typeof currentPrice === 'number') {
            const entryPrice = parseFloat(trade.entry_price);
            const quantity = parseFloat(trade.quantity);
            totalUnrealizedPnl += (trade.direction === 'LONG') ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
          }
        }
      }
      const userOwnershipPct = (vaultTotalPrincipal > 0) ? (userPrincipal / vaultTotalPrincipal) : 0;
      const unrealizedPnl = totalUnrealizedPnl * userOwnershipPct;
      userPosition = { totalCapital: userPrincipal + realizedPnl + unrealizedPnl, principal: userPrincipal, realizedPnl: realizedPnl, unrealizedPnl: unrealizedPnl, };
    }
    let runningBalance = 0;
    const userPerformanceHistory = userLedgerEntries.map(entry => { runningBalance += parseFloat(entry.amount); return { date: entry.created_at, balance: runningBalance, }; });
    const capitalInTransit = userLedgerEntries.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const pendingWithdrawals = userLedgerEntries.filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_')).reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);
    const responsePayload = { vaultInfo, assetBreakdown: assetBreakdownWithPrices, userPosition, userLedger: userLedgerEntries.reverse(), userPerformanceHistory, vaultStats: { capitalInTransit, pendingWithdrawals, }, };
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
