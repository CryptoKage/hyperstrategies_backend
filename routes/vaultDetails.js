// /routes/vaultDetails.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { getPrices } = require('../utils/priceOracle'); // <-- 1. Use our new centralized oracle

// This endpoint is now the single source of truth for the vault detail page.
router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    // --- Step 1: Fetch all necessary data in parallel ---
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
      // Get all ledger entries for this user in this vault
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [userId, vaultId]),
      // Get the total principal deposited into the vault across ALL users
      client.query(`SELECT COALESCE(SUM(amount), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId])
    ]);

    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found.' });
    }

    const vaultInfo = vaultInfoResult.rows[0];
    const vaultAssets = assetBreakdownResult.rows;
    const openTrades = openTradesResult.rows;
    const userLedgerEntries = userLedgerResult.rows;
    const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);

    // --- Step 2: Get live prices using our robust oracle ---
    const priceMap = await getPrices(vaultAssets);
    const assetBreakdownWithPrices = vaultAssets.map(asset => ({
      ...asset,
      livePrice: priceMap.get(asset.contract_address.toLowerCase()) || null,
    }));

    // --- Step 3: Calculate the user's detailed, real-time position ---
    let userPosition = null;
    if (userLedgerEntries.length > 0) {
      // Calculate user's principal and realized PNL from their ledger
      const userPrincipal = userLedgerEntries
        .filter(e => e.entry_type === 'DEPOSIT')
        .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      
      const realizedPnl = userLedgerEntries
        .filter(e => e.entry_type === 'PNL_DISTRIBUTION')
        .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);

      // Calculate user's share of the vault's total unrealized PNL
      let totalUnrealizedPnl = 0;
      for (const trade of openTrades) {
        const assetDetail = vaultAssets.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
        if (assetDetail && assetDetail.contract_address) {
          const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
          if (typeof currentPrice === 'number') {
            const entryPrice = parseFloat(trade.entry_price);
            const quantity = parseFloat(trade.quantity);
            totalUnrealizedPnl += (trade.direction === 'LONG') 
              ? (currentPrice - entryPrice) * quantity 
              : (entryPrice - currentPrice) * quantity;
          }
        }
      }

      // User's ownership percentage of the vault's capital
      const userOwnershipPct = (vaultTotalPrincipal > 0) ? (userPrincipal / vaultTotalPrincipal) : 0;
      const unrealizedPnl = totalUnrealizedPnl * userOwnershipPct;

      userPosition = {
        totalCapital: userPrincipal + realizedPnl + unrealizedPnl,
        principal: userPrincipal,
        realizedPnl: realizedPnl,
        unrealizedPnl: unrealizedPnl,
      };
    }

    // --- Step 4: Generate the user's historical performance for the chart ---
    let runningBalance = 0;
    const userPerformanceHistory = userLedgerEntries.map(entry => {
      runningBalance += parseFloat(entry.amount);
      return {
        date: entry.created_at,
        balance: runningBalance,
      };
    });

    // --- Step 5: Calculate stats for capital in transit ---
    const capitalInTransit = userLedgerEntries
      .filter(e => e.status === 'PENDING_SWEEP')
      .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      
    const pendingWithdrawals = userLedgerEntries
      .filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_'))
      .reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);

    // --- Step 6: Assemble the final, clean payload for the frontend ---
    const responsePayload = {
      vaultInfo,
      assetBreakdown: assetBreakdownWithPrices,
      userPosition,
      userLedger: userLedgerEntries.reverse(), // Show most recent first in the table
      userPerformanceHistory,
      vaultStats: {
        capitalInTransit,
        pendingWithdrawals,
      },
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
