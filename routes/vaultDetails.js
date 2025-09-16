// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/routes/vaultDetails.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const fetch = require('node-fetch');
const { resolveNetworkByName } = require('../services/alchemy');

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const vaultInfoResult = await client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]);
    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found.' });
    }

    // --- Step 1: Fetch all data concurrently ---
    const [
      performanceHistoryResult,
      assetBreakdownResult,
      tradesResult,
      vaultLedgerStatsResult,
      userLedgerResult
    ] = await Promise.all([
      client.query(`SELECT record_date, pnl_percentage, total_value_locked FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 30`, [vaultId]),
      client.query('SELECT symbol, contract_address, chain, weight, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1', [vaultId]),
      client.query(`SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEPOSIT' THEN amount ELSE 0 END), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1`, [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at DESC`, [userId, vaultId])
    ]);

    const allTrades = tradesResult.rows;
    const openTrades = allTrades.filter(t => t.status === 'OPEN');
    const priceMap = new Map();
    // (Price fetching logic remains the same, omitted for brevity)
    
    // --- Step 2: Live Price Fetching (Hybrid Oracle) ---
    // This logic is unchanged but is crucial for the next step.
    const vaultAssets = assetBreakdownResult.rows;
    priceMap.set('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(), 1.0);
    const assetsToFetch = vaultAssets.filter(a => a.symbol.toUpperCase() !== 'USDC');
    if (assetsToFetch.length > 0) {
        try {
            const response = await fetch(HYPERLIQUID_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: "allMids" }) });
            if (response.ok) {
                const mids = await response.json();
                for (const asset of assetsToFetch) {
                    const priceStr = mids[asset.symbol.toUpperCase()];
                    if (priceStr) priceMap.set(asset.contract_address.toLowerCase(), parseFloat(priceStr));
                }
            }
        } catch (err) { console.error('[VaultDetails] Hyperliquid fetch failed:', err.message); }
    }
    
    // --- Step 3: Calculate User-Specific PNL and Stats ---
    let userPosition = null;
    const userLedger = userLedgerResult.rows;
    const userTotalCapital = userLedger.reduce((sum, entry) => sum + parseFloat(entry.amount), 0);

    if (userTotalCapital > 0) {
        const userPrincipal = userLedger.filter(e => e.entry_type === 'DEPOSIT').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
        const userRealizedPnl = userLedger.filter(e => e.entry_type === 'PNL_DISTRIBUTION').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
        
        const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);
        const userOwnershipPct = (vaultTotalPrincipal > 0) ? (userPrincipal / vaultTotalPrincipal) : 0;

        let userUnrealizedPnl = 0;
        const userPnlByAsset = {};

        for (const trade of openTrades) {
            const assetDetail = vaultAssets.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
            if (assetDetail && assetDetail.contract_address) {
                const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
                if (typeof currentPrice === 'number') {
                    const entryPrice = parseFloat(trade.entry_price);
                    const quantity = parseFloat(trade.quantity);
                    const tradePnl = (trade.direction === 'LONG') ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
                    
                    const userShareOfPnl = tradePnl * userOwnershipPct;
                    userUnrealizedPnl += userShareOfPnl;

                    if (!userPnlByAsset[assetDetail.symbol]) userPnlByAsset[assetDetail.symbol] = 0;
                    userPnlByAsset[assetDetail.symbol] += userShareOfPnl;
                }
            }
        }

        userPosition = {
            totalCapital: userTotalCapital,
            totalPnl: userRealizedPnl + userUnrealizedPnl,
            pnlByAsset: userPnlByAsset
        };
    }
    
    const userCapitalInTransit = userLedger.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const userPendingWithdrawals = userLedger.filter(e => e.status === 'PENDING_FUNDING' || e.status === 'PENDING_CONFIRMATION' || e.status === 'SWEEP_CONFIRMED').reduce((sum, entry) => sum - parseFloat(entry.amount), 0);

    // --- Step 4: Assemble Final Payload ---
    const responsePayload = {
      vaultInfo: vaultInfoResult.rows[0],
      performanceHistory: performanceHistoryResult.rows,
      assetBreakdown: vaultAssets.map(asset => ({
        ...asset,
        livePrice: priceMap.get(asset.contract_address.toLowerCase()) || null
      })),
      userPosition,
      userLedger,
      vaultStats: {
        capitalInTransit: userCapitalInTransit,
        pendingWithdrawals: userPendingWithdrawals
      },
    };
    
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
