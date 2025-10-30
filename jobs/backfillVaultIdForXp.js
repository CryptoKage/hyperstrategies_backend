// FILE: cryptokage-hyperstrategies_backend/jobs/backfillVaultIdForXp.js

require('dotenv').config();
const pool = require('../db');
const moment = require('moment'); // moment is a dependency, so this is safe

const backfillVaultIds = async () => {
    console.log('--- Starting Backfill Script for related_vault_id on XP logs ---');
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Part 1: Backfill for DEPOSIT BONUSES ---
        const depositBonusesToFix = await client.query(`
            SELECT activity_id, user_id, created_at 
            FROM user_activity_log 
            WHERE activity_type = 'XP_DEPOSIT_BONUS' AND related_vault_id IS NULL;
        `);

        console.log(`Found ${depositBonusesToFix.rowCount} deposit bonus logs to update.`);

        for (const log of depositBonusesToFix.rows) {
            // For each log, find the most recent vault deposit that occurred at or before the XP award.
            // This is a reliable heuristic to associate the XP with the correct vault deposit.
            const vaultDeposit = await client.query(`
                SELECT vault_id FROM vault_ledger_entries 
                WHERE user_id = $1 AND entry_type IN ('DEPOSIT', 'VAULT_TRANSFER_IN') AND created_at <= $2
                ORDER BY created_at DESC LIMIT 1;
            `, [log.user_id, log.created_at]);

            if (vaultDeposit.rows.length > 0) {
                const vaultId = vaultDeposit.rows[0].vault_id;
                await client.query(
                    'UPDATE user_activity_log SET related_vault_id = $1 WHERE activity_id = $2',
                    [vaultId, log.activity_id]
                );
                console.log(`  - Linked deposit bonus log ${log.activity_id} to vault ${vaultId}`);
            } else {
                console.warn(`  - Could not find a matching deposit for XP log ${log.activity_id}. Skipping.`);
            }
        }
        
        // --- Part 2: Backfill for STAKING BONUSES ---
        // Staking XP is a global benefit, but for accounting, we'll associate it with the primary vault.
        const stakingBonusesToFix = await client.query(`
            SELECT activity_id
            FROM user_activity_log
            WHERE activity_type IN ('XP_STAKING_BONUS', 'XP_STAKING_BONUS_CATCHUP') AND related_vault_id IS NULL;
        `);

        console.log(`Found ${stakingBonusesToFix.rowCount} staking bonus logs to update.`);
        
        if (stakingBonusesToFix.rowCount > 0) {
            const idsToUpdate = stakingBonusesToFix.rows.map(r => r.activity_id);
            // We associate all general staking XP with the Core Strategy (vault_id = 1)
            await client.query(
                `UPDATE user_activity_log SET related_vault_id = 1 WHERE activity_id = ANY($1::uuid[])`,
                [idsToUpdate]
            );
            console.log(`  - Linked ${idsToUpdate.length} staking logs to Core Strategy (Vault 1).`);
        }
        
        await client.query('COMMIT');
        console.log('--- ✅ Backfill complete! Transaction committed. ---');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('--- ❌ ERROR during backfill, transaction has been rolled back. ---');
        console.error(error);
    } finally {
        client.release();
        // We end the pool connection because this is a one-off script.
        pool.end(); 
    }
};

backfillVaultIds();
