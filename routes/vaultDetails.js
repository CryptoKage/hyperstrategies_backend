// hyperstrategies_backend/routes/vaultDetails.js

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
  }

  const client = await pool.connect();
  try {
    const [
      vaultInfoResult,
      assetBreakdownResult,
      openTradesResult,
      userLedgerResult,
      farmingProtocolsResult,
      buybackGainsResult,
      xpGainsResult
    ] = await Promise.all([
      client.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
      client.query('SELECT symbol, contract_address, chain, coingecko_id, is_primary_asset FROM vault_assets WHERE vault_id = $1', [vaultId]),
      client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]),
      client.query(`SELECT * FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 ORDER BY created_at ASC`, [targetUserId, vaultId]),
      client.query(`SELECT protocol_id, name, chain, description, status FROM farming_protocols WHERE vault_id = $1 ORDER BY status, name ASC`, [vaultId]),
      client.query(`SELECT COALESCE(SUM(amount_primary), 0) as total_gains FROM user_activity_log WHERE user_id = $1 AND activity_type IN ('BONUS_POINT_BUYBACK', 'PLATFORM_REWARD') AND related_vault_id = $2`, [targetUserId, vaultId]),
      client.query(`SELECT COALESCE(SUM(CASE WHEN activity_type LIKE 'XP_DEPOSIT_BONUS' THEN amount_primary ELSE 0 END), 0) as deposit_xp, COALESCE(SUM(CASE WHEN activity_type LIKE 'XP_STAKING_BONUS' THEN amount_primary ELSE 0 END), 0) as staking_xp FROM user_activity_log WHERE user_id = $1 AND related_vault_id = $2`, [targetUserId, vaultId])
    ]);

    if (vaultInfoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    const vaultInfo = vaultInfoResult.rows[0];
    const userLedgerEntries = userLedgerResult.rows;
    const buybackGains = parseFloat(buybackGainsResult.rows[0]?.total_gains || 0);
    const xpFromDeposits = parseFloat(xpGainsResult.rows[0]?.deposit_xp || 0);
    const xpFromStaking = parseFloat(xpGainsResult.rows[0]?.staking_xp || 0);

    let userPosition = null;
    if (userLedgerEntries.length > 0) {
      const principal = userLedgerEntries.filter(e => e.entry_type === 'DEPOSIT' || e.entry_type === 'VAULT_TRANSFER_IN').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      const strategyGains = userLedgerEntries.filter(e => e.entry_type === 'PNL_DISTRIBUTION').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      const unrealizedPnl = 0; // Placeholder
      const totalCapital = principal + strategyGains + buybackGains;

      userPosition = { 
        totalCapital, 
        principal, 
        strategyGains,
        unrealizedPnl, // Keep for consistency even if 0
        buybackGains,
        totalXpFromVault: xpFromDeposits + xpFromStaking,
        xpBreakdown: { deposit: xpFromDeposits, staking: xpFromStaking }
      };
    }

    const capitalInTransit = userLedgerEntries.filter(e => e.status === 'PENDING_SWEEP').reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
    const pendingWithdrawals = userLedgerEntries.filter(e => e.entry_type === 'WITHDRAWAL_REQUEST' && e.status.startsWith('PENDING_')).reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount)), 0);

    const responsePayload = {
      vaultInfo,
      userPosition,
      userLedger: userLedgerEntries.reverse(),
      vaultStats: { capitalInTransit, pendingWithdrawals },
      assetBreakdown: assetBreakdownResult.rows,
      openTrades: openTradesResult.rows,
      farmingProtocols: farmingProtocolsResult.rows,
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
