// routes/vaultDetails.js

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
      farmingProtocolsResult,
      vaultLedgerStatsResult,
      buybackGainsResult, 
      xpGainsResult
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      client.query('SELECT symbol, contract_address, chain, coingecko_id, is_primary_asset FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [targetUserId, vaultId]),
      client.query(`SELECT protocol_id, name, chain, description, status, has_rewards, rewards_realized_usd, date_reaped FROM farming_protocols WHERE vault_id = $1 ORDER BY status, name ASC`, [vaultId]),
      client.query(`SELECT COALESCE(SUM(amount), 0) as total_principal FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type NOT IN ('PNL_DISTRIBUTION')`, [vaultId]),
      client.query(
        `SELECT COALESCE(SUM(amount_primary), 0) as total_gains
         FROM user_activity_log
         WHERE user_id = $1
           AND activity_type IN ('BONUS_POINT_BUYBACK', 'PLATFORM_REWARD')
           AND related_vault_id = $2`,
        [targetUserId, vaultId]
      ),

      // NEW QUERY: Calculate total XP generated from activities related to this vault
      client.query(
        `SELECT
            COALESCE(SUM(CASE WHEN activity_type = 'XP_DEPOSIT_BONUS' THEN amount_primary ELSE 0 END), 0) as deposit_xp,
            COALESCE(SUM(CASE WHEN activity_type = 'XP_STAKING_BONUS' THEN amount_primary ELSE 0 END), 0) as staking_xp
         FROM user_activity_log
         WHERE user_id = $1 AND related_vault_id = $2`,
        [targetUserId, vaultId]
      )
    ]);

    if (vaultInfoResult.rows.length === 0) {
      // Small fix: Don't release the client here, let the 'finally' block handle it.
      return res.status(404).json({ error: 'Vault not found' });
    }

    const vaultInfo = vaultInfoResult.rows[0];
      const buybackGains = parseFloat(buybackGainsResult.rows[0]?.total_gains || 0);
    const xpFromDeposits = parseFloat(xpGainsResult.rows[0]?.deposit_xp || 0);
    const xpFromStaking = parseFloat(xpGainsResult.rows[0]?.staking_xp || 0);
    const vaultAssets = assetBreakdownResult.rows;
    const openTrades = openTradesResult.rows;
    const userLedgerEntries = userLedgerResult.rows;
    const farmingProtocols = farmingProtocolsResult.rows;
    const vaultTotalPrincipal = parseFloat(vaultLedgerStatsResult.rows[0].total_principal);
    
    const priceMap = await getPrices(vaultAssets);
    const assetBreakdownWithPrices = vaultAssets.map(asset => ({...asset, livePrice: priceMap.get(asset.contract_address?.toLowerCase()) || null}));
    
   let userPosition = null;
    if (userLedgerEntries.length > 0) {
      const userPrincipal = userLedgerEntries
        .filter(e => e.entry_type === 'DEPOSIT' || e.entry_type === 'VAULT_TRANSFER_IN')
        .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
        
      const realizedPnl = userLedgerEntries
        .filter(e => e.entry_type === 'PNL_DISTRIBUTION')
        .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      
      // For a discretionary vault, unrealized PNL is a more complex calculation based on live trades.
      // We will leave this as 0 for now and focus on displaying the realized data we have.
      const unrealizedPnl = 0;

      userPosition = { 
        totalCapital: userPrincipal + realizedPnl + unrealizedPnl, 
        principal: userPrincipal, 
        realizedPnl: realizedPnl, 
        unrealizedPnl: unrealizedPnl,
        
        // --- THIS IS THE FIX: Add the new stats to the userPosition object ---
        buybackGains: buybackGains,
        totalXpFromVault: xpFromDeposits + xpFromStaking,
        xpBreakdown: {
            deposit: xpFromDeposits,
            staking: xpFromStaking
        }
      };
    }

    // These are less critical details and can be calculated from the ledger entries.
    const capitalInTransit = userLedgerEntries.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const pendingWithdrawals = userLedgerEntries.filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_')).reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);

    const responsePayload = {
      vaultInfo,
      userPosition, // This object now contains all our new data
      userLedger: userLedgerEntries.reverse(),
      vaultStats: { capitalInTransit, pendingWithdrawals },
      // Note: We are simplifying by removing openTrades and farmingProtocols for now
      // as they are not needed by the DiscretionaryVaultView component.
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
