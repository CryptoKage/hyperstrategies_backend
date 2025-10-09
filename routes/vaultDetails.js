// routes/vaultDetails.js

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
      farmingProtocolsResult,
      vaultLedgerStatsResult // Added for ownership calculation
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      // CORRECTED QUERY: Fetch all columns for assets once.
      client.query('SELECT symbol, contract_address, chain, coingecko_id, is_primary_asset FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [targetUserId, vaultId]),
      client.query(`SELECT protocol_id, name, chain, description, status, has_rewards, rewards_realized_usd, date_reaped FROM farming_protocols WHERE vault_id = $1 ORDER BY status, name ASC`, [vaultId]),
      // CORRECTED QUERY: Get total principal for the whole vault, not just deposits.
      client.query(`SELECT COALESCE(SUM(amount), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type NOT IN ('PNL_DISTRIBUTION')`, [vaultId])
    ]);

    if (vaultInfoResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Vault not found' });
    }

    const vaultInfo = vaultInfoResult.rows[0];
    const vaultAssets = assetBreakdownResult.rows;
    const openTrades = openTradesResult.rows;
    const userLedgerEntries = userLedgerResult.rows;
    const farmingProtocols = farmingProtocolsResult.rows;
    const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);
    
    const priceMap = await getPrices(vaultAssets);
    const assetBreakdownWithPrices = vaultAssets.map(asset => ({...asset, livePrice: priceMap.get(asset.contract_address?.toLowerCase()) || null}));
    
    let userPosition = null;
    if (userLedgerEntries.length > 0) {
      const userPrincipal = userLedgerEntries.filter(e => e.entry_type === 'DEPOSIT' || e.entry_type === 'VAULT_TRANSFER_IN').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
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

    const capitalInTransit = userLedgerEntries.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const pendingWithdrawals = userLedgerEntries.filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_')).reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);

    const responsePayload = {
      vaultInfo,
      assetBreakdown: assetBreakdownWithPrices,
      userPosition,
      userLedger: userLedgerEntries.reverse(),
      openTrades, // Pass this down for Reserve Vault
      farmingProtocols, // Pass this down for Farming Vault
      vaultStats: { capitalInTransit, pendingWithdrawals, totalPrincipal: vaultTotalPrincipal }, // Pass down vault total principal
    };
    
    res.json(responsePayload);

  } catch (error) {
    console.error(`Error fetching details for Vault ${vaultId}:`, error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch vault details.' });
  } finally {
    if (client) client.release();
  }
});
