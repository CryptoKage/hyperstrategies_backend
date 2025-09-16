// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/routes/vaultDetails.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const fetch = require('node-fetch'); // We'll need fetch for the oracle
const { getAlchemyClient, resolveNetworkByName } = require('../services/alchemy');

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

router.get('/:vaultId', authenticateToken, async (req, res) => {
  const { vaultId } = req.params;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    // --- Step 1: Fetch all primary, non-user-specific data ---
    const [
      vaultInfoResult,
      performanceHistoryResult,
      assetBreakdownResult,
      tradesResult,
      vaultLedgerStatsResult
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      client.query(`SELECT record_date, pnl_percentage, total_value_locked FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 30`, [vaultId]),
      client.query('SELECT symbol, contract_address, chain, weight, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 ORDER BY trade_opened_at DESC', [vaultId]),
      client.query(`
          SELECT
              COALESCE(SUM(CASE WHEN status = 'PENDING_SWEEP' THEN amount ELSE 0 END), 0) as capital_in_transit,
              COALESCE(SUM(CASE WHEN entry_type = 'DEPOSIT' THEN amount ELSE 0 END), 0) as total_principal
          FROM vault_ledger_entries WHERE vault_id = $1
      `, [vaultId])
    ]);

    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found.' });
    }

    // --- Step 2: Fetch Live Prices using our Hybrid Oracle Logic ---
    const vaultAssets = assetBreakdownResult.rows;
    const priceMap = new Map();
    priceMap.set('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(), 1.0); // Hardcode USDC

    const assetsToFetch = vaultAssets.filter(a => a.symbol.toUpperCase() !== 'USDC');
    if (assetsToFetch.length > 0) {
        try {
            const response = await fetch(HYPERLIQUID_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "allMids" }),
            });
            if (response.ok) {
                const mids = await response.json();
                for (const asset of assetsToFetch) {
                    const priceStr = mids[asset.symbol.toUpperCase()];
                    if (priceStr) priceMap.set(asset.contract_address.toLowerCase(), parseFloat(priceStr));
                }
            }
        } catch (err) { console.error('[VaultDetails] Hyperliquid fetch failed:', err.message); }
    }

    const assetsMissingPrice = vaultAssets.filter(a => !priceMap.has(a.contract_address.toLowerCase()));
    if (assetsMissingPrice.length > 0) {
        try {
            const apiKey = process.env.ALCHEMY_API_KEY;
            const response = await fetch(`https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    addresses: assetsMissingPrice.map(asset => ({ address: asset.contract_address, network: resolveNetworkByName(asset.chain) }))
                }),
            });
            if (response.ok) {
                const json = await response.json();
                for (const token of json.data) {
                    if (token.prices[0]?.value) priceMap.set(token.address.toLowerCase(), parseFloat(token.prices[0].value));
                }
            }
        } catch (err) { console.error('[VaultDetails] Alchemy fallback failed:', err.message); }
    }

    const liveAssetData = vaultAssets.map(asset => ({
      ...asset,
      livePrice: priceMap.get(asset.contract_address.toLowerCase()) || null
    }));

    // --- Step 3: Prepare the Base Payload for All Users ---
    const allTrades = tradesResult.rows;
    const responsePayload = {
      vaultInfo: vaultInfoResult.rows[0],
      performanceHistory: performanceHistoryResult.rows,
      assetBreakdown: liveAssetData,
      openTrades: allTrades.filter(t => t.status === 'OPEN'),
      tradeHistory: allTrades.filter(t => t.status === 'CLOSED'),
      vaultStats: {
        totalValueLocked: performanceHistoryResult.rows[0]?.total_value_locked || 0,
        capitalInTransit: parseFloat(vaultLedgerStatsResult.rows[0].capital_in_transit),
        totalPrincipal: parseFloat(vaultLedgerStatsResult.rows[0].total_principal),
      },
      // Initialize user-specific data as null
      userPosition: null,
      userLedger: null,
    };

    // --- Step 4: If the user is invested, fetch their specific data ---
    const userPositionResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total_capital FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2`,
      [userId, vaultId]
    );

    const userTotalCapital = parseFloat(userPositionResult.rows[0].total_capital);
    
    if (userTotalCapital > 0) {
      const [userPnlResult, userLedgerResult] = await Promise.all([
          client.query(
            `SELECT COALESCE(SUM(CASE WHEN entry_type = 'PNL_DISTRIBUTION' THEN amount ELSE 0 END), 0) as total_pnl FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2`,
            [userId, vaultId]
          ),
          client.query(
            `SELECT entry_id, entry_type, amount, created_at, status FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at DESC`,
            [userId, vaultId]
          )
      ]);
      
      responsePayload.userPosition = {
        totalCapital: userTotalCapital,
        totalPnl: parseFloat(userPnlResult.rows[0].total_pnl)
      };
      responsePayload.userLedger = userLedgerResult.rows;
    }
    
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
