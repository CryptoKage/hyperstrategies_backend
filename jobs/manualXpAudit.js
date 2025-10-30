// /jobs/manualXpAudit.js

require('dotenv').config();
const moment = require('moment');
const pool = require('../db');
const { calculateActiveEffects } = require('../utils/effectsEngine');
const { awardXp } = require('../utils/xpEngine');
const { calculateUserTier } = require('../utils/tierUtils');

// --- CONFIGURATION ---

// Set to 'false' to execute the changes. ALWAYS run in 'true' first.
const DRY_RUN = true; 

// Set to 'true' to run for all users, or 'false' to run only for the IDs below.
const RUN_FOR_ALL_USERS = false; 

// Add the specific user UUIDs you want to audit here.
const userIdsToAudit = [
   'acde1fad-0e79-402a-a0ef-efe8f2738871', // 1234
    'ebaddbc4-f382-4782-97f8-5fbf100c811b', // aarondean
    'c46df9e8-6cf8-4555-bdac-74cd3b5bda9d', // Kage Token
    'eccbec70-4443-4c8b-8d25-2358f86036c4', // MisterBuggy
    '0932e6f3-4004-46c2-939b-ea0d32dc7831', // m.schulz@netcologne.de
    '4c3fa0f7-e083-4fc5-b74f-6ea4216842c6', // NotAdmin
    '2749e30f-d5ca-4ecb-a2f3-55b237ae1220', // Sabine Boos
    '085ee643-c11e-4108-89f8-5e749a979173', // SG
    '71bd55c5-d7c3-4465-9a0b-31a2c727eb27', // Steffen
    '5407b11c-5b44-4881-bb89-95ecad93dcab', // Toraji
    'ffb33864-e0ba-4d25-87a4-a95afc47b135', // Zom Cakes
];

// --- SCRIPT LOGIC ---

const runAudit = async () => {
    console.log(`--- Starting XP Reconciliation Script ---`);
    console.log(`--- MODE: ${DRY_RUN ? 'DRY RUN (No changes will be made)' : 'EXECUTE (DATABASE WILL BE MODIFIED)'} ---`);
    
    const client = await pool.connect();
    try {
        let targetUsers;
        if (RUN_FOR_ALL_USERS) {
            console.log('--- Targeting: ALL users ---');
            const allUsersResult = await client.query('SELECT user_id, username FROM users ORDER BY created_at ASC');
            targetUsers = allUsersResult.rows;
        } else {
            console.log(`--- Targeting: ${userIdsToAudit.length} specific users ---`);
            if (userIdsToAudit.length === 0) {
                console.log('No user IDs provided in userIdsToAudit array. Exiting.');
                return;
            }
            const specificUsersResult = await client.query('SELECT user_id, username FROM users WHERE user_id = ANY($1::uuid[])', [userIdsToAudit]);
            targetUsers = specificUsersResult.rows;
        }

        for (const user of targetUsers) {
            console.log(`\n--- Processing User: ${user.username} (${user.user_id}) ---`);
            
            // --- Part A: Calculate Missing Historical Staking XP ---
            const ledgerEntries = (await client.query(`SELECT vault_id, entry_type, amount, created_at FROM vault_ledger_entries WHERE user_id = $1 ORDER BY created_at ASC`, [user.user_id])).rows;
            const existingStakingXp = (await client.query(`SELECT related_vault_id, amount_primary, created_at FROM user_activity_log WHERE user_id = $1 AND activity_type = 'XP_STAKING_BONUS'`, [user.user_id])).rows;

            if (ledgerEntries.length === 0) {
                console.log('User has no vault history. Skipping staking XP calculation.');
                continue;
            }

            const dailyCapital = new Map();
            const firstDate = moment.utc(ledgerEntries[0].created_at).startOf('day');
            const today = moment.utc().startOf('day');

            for (let m = moment(firstDate); m.isBefore(today); m.add(1, 'days')) {
                const currentDateStr = m.format('YYYY-MM-DD');
                let capitalForDay = 0;
                // Simplified capital calculation: sum all entries up to the end of this day
                ledgerEntries.forEach(entry => {
                    if (moment.utc(entry.created_at).isSameOrBefore(m, 'day')) {
                        capitalForDay += parseFloat(entry.amount);
                    }
                });
                if (capitalForDay > 0) {
                    dailyCapital.set(currentDateStr, capitalForDay);
                }
            }

            const awardedStakingXpMap = new Map();
            existingStakingXp.forEach(log => {
                const dateStr = moment.utc(log.created_at).format('YYYY-MM-DD');
                awardedStakingXpMap.set(dateStr, parseFloat(log.amount_primary));
            });

            const missingStakingLogs = [];
            for (const [dateStr, capital] of dailyCapital.entries()) {
                if (!awardedStakingXpMap.has(dateStr)) {
                    const expectedXp = capital / 300;
                    if (expectedXp > 0) {
                        missingStakingLogs.push({
                            date: dateStr,
                            xp: expectedXp
                        });
                    }
                }
            }
            
            const totalMissingStakingXp = missingStakingLogs.reduce((sum, log) => sum + log.xp, 0);
            if (missingStakingLogs.length > 0) {
                console.log(`Found ${missingStakingLogs.length} days of missing staking XP, totaling: ${totalMissingStakingXp.toFixed(4)} XP`);
            } else {
                console.log('No missing staking XP found.');
            }

            // --- Part B: Full Audit ---
            const activityLogs = (await client.query(`SELECT amount_primary, status FROM user_activity_log WHERE user_id = $1 AND activity_type LIKE 'XP_%'`, [user.user_id])).rows;
            const dbTotal = (await client.query('SELECT xp FROM users WHERE user_id = $1', [user.user_id])).rows[0].xp;
            
            const calculatedTotalFromLogs = activityLogs
                .filter(log => log.status === 'COMPLETED' || log.status === 'CLAIMED')
                .reduce((sum, log) => sum + parseFloat(log.amount_primary), 0);
                
            const finalCalculatedTotal = calculatedTotalFromLogs + totalMissingStakingXp;
            const discrepancy = parseFloat(dbTotal) - finalCalculatedTotal;

            console.log(`  DB Total XP:         ${parseFloat(dbTotal).toFixed(4)}`);
            console.log(`  Calculated Total XP: ${finalCalculatedTotal.toFixed(4)}`);
            if (Math.abs(discrepancy) > 0.0001) {
                console.log(`  Discrepancy:         ${discrepancy.toFixed(4)} (NEEDS CORRECTION)`);
            } else {
                console.log('  Discrepancy:         0.0000 (OK)');
            }

            // --- Part C: Correction ---
            if (!DRY_RUN && (totalMissingStakingXp > 0 || Math.abs(discrepancy) > 0.0001)) {
                console.log('--- EXECUTING CORRECTIONS ---');
                await client.query('BEGIN');
                try {
                    // 1. Insert missing staking XP logs (if any)
                    for (const log of missingStakingLogs) {
                        // For simplicity, we assign missing XP to the main vault (ID 1) or leave null
                        const vaultIdForLog = 1; 
                        await awardXp({
                            userId: user.user_id,
                            xpAmount: log.xp,
                            type: 'STAKING_BONUS_CATCHUP',
                            descriptionKey: 'xp_history.staking_bonus_catchup',
                            descriptionVars: { amount: log.xp.toFixed(4), date: log.date },
                            relatedVaultId: vaultIdForLog
                        }, client);
                    }
                    if (missingStakingLogs.length > 0) {
                        console.log(`Inserted ${missingStakingLogs.length} catch-up staking XP logs.`);
                    }

                    // 2. Set the final correct total
                    await client.query('UPDATE users SET xp = $1 WHERE user_id = $2', [finalCalculatedTotal, user.user_id]);
                    
                    // 3. Recalculate and set the tier
                    const newTier = calculateUserTier(finalCalculatedTotal);
                    await client.query('UPDATE users SET account_tier = $1 WHERE user_id = $2', [newTier, user.user_id]);
                    console.log(`Set final XP to ${finalCalculatedTotal.toFixed(4)} and tier to ${newTier}.`);
                    
                    await client.query('COMMIT');
                    console.log('--- CORRECTIONS COMMITTED ---');
                } catch (e) {
                    await client.query('ROLLBACK');
                    console.error('--- ERROR DURING EXECUTION, ROLLED BACK ---', e);
                }
            }
        }
    } catch (error) {
        console.error('A major error occurred:', error);
    } finally {
        client.release();
        console.log('\n--- Script finished. ---');
    }
};

runAudit();
