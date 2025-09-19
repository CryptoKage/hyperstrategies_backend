// /routes/vaultDetails.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { getPrices } = require('../utils/priceOracle');

router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  
  let targetUserId = req.user.id;
  if (req.user.isAdmin && req.query.userId) {
    targetUserId = req.query.userId;
    console.log(`[Admin View] Admin ${req.user.id} is viewing vault ${vaultId} as user ${targetUserId}`);
  }

  const client = await pool.connect();

  try {
    const [
      vaultInfoResult,
      assetBreakdownResult,
      openTradesResult,
      userLedgerResult,
      vaultLedgerStatsResult
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      client.query('SELECT symbol, contract_address, chain, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [targetUserId, vaultId]),
      client.query(`SELECT COALESCE(SUM(amount), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId])
    ]);

    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found' });
    }
    const vaultInfo = vaultInfoResult.rows[0];
    const vaultAssets = assetBreakdownResult.rows;
    const openTrades = openTradesResult.rows;
    const userLedgerEntries = userLedgerResult.rows;
    const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);
    const priceMap = await getPrices(vaultAssets);
    const assetBreakdownWithPrices = vaultAssets.map(asset => ({...asset, livePrice: priceMap.get(asset.contract_address?.toLowerCase()) || null}));
    
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
      userPosition = { totalCapital: userPrincipal + realizedPnl + unrealizedPnl, principal: userPrincipal, realizedPnl: realizedPnl, unrealizedPnl: unrealizedPnl };
    }

    let runningBalance = 0;
    const userPerformanceHistory = userLedgerEntries.map(entry => { runningBalance += parseFloat(entry.amount); return { date: entry.created_at, balance: runningBalance }; });
    const capitalInTransit = userLedgerEntries.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const pendingWithdrawals = userLedgerEntries.filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_')).reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);

    // =============================================================
    // --- FINAL ADDITION: Calculate a projected index value ---
    // =============================================================
    let projectedIndexValue = null;
    // We only calculate a projection if the user has an active position
    if (userPosition) {
        const lastIndexResult = await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId]);

        if (lastIndexResult.rows.length > 0) {
            const lastIndex = parseFloat(lastIndexResult.rows[0].index_value);
            // The capital base for this calculation is the user's total settled capital (before unrealized P&L)
            const settledCapital = userPosition.principal + userPosition.realizedPnl;
            if (settledCapital > 0) {
                // The performance impact is the unrealized P&L relative to their settled capital
                const unrealizedPerf = userPosition.unrealizedPnl / settledCapital;
                projectedIndexValue = lastIndex * (1 + unrealizedPerf);
            } else {
                // If there's no settled capital, the projection is just the last known index
                projectedIndexValue = lastIndex;
            }
        }
    }
    // =============================================================
    // --- END OF ADDITION ---
    // =============================================================

    const responsePayload = {
      vaultInfo,
      assetBreakdown: assetBreakdownWithPrices,
      userPosition,
      userLedger: userLedgerEntries.reverse(),
      userPerformanceHistory,
      vaultStats: { capitalInTransit, pendingWithdrawals },
      projectedIndexValue, // Add the new value to the payload
    };
    
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
