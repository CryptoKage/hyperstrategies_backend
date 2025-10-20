// routes/farming.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

router.get('/:vaultId/my-status', authenticateToken, async (req, res) => {
    const { vaultId } = req.params;
    const userId = req.user.id;
    const client = await pool.connect();

    try {
        // --- 1. Fetch all protocols for this vault ---
        const protocolsResult = await client.query(
            `SELECT protocol_id, name, status, date_farming_started, date_reaped 
             FROM farming_protocols 
             WHERE vault_id = $1 
             ORDER BY created_at DESC`,
            [vaultId]
        );
        const allProtocols = protocolsResult.rows;

        if (allProtocols.length === 0) {
            return res.json([]); // Return an empty array if the vault has no farming protocols
        }

        // --- 2. Fetch all of the user's contributions in this vault ---
        const contributionsResult = await client.query(
            `SELECT protocol_id, entry_type, amount, created_at
             FROM farming_contribution_ledger
             WHERE user_id = $1 AND vault_id = $2`,
            [userId, vaultId]
        );
        const userContributions = contributionsResult.rows;

        // --- 3. Process the data to build the final response ---
        const responseData = allProtocols.map(protocol => {
            const userEventsForProtocol = userContributions.filter(c => c.protocol_id === protocol.protocol_id);
            
            let userStatus = "Not Involved";
            let hasContributed = false;
            let currentBalance = 0;

            if (userEventsForProtocol.length > 0) {
                hasContributed = true;
                currentBalance = userEventsForProtocol.reduce((sum, event) => {
                    return event.entry_type === 'CONTRIBUTION' ? sum + parseFloat(event.amount) : sum - parseFloat(event.amount);
                }, 0);
            }

            if (protocol.status === 'FARMING' && currentBalance > 0) {
                userStatus = "Currently Farming";
            } else if (hasContributed) {
                userStatus = "Contributed"; // They were involved, but have either withdrawn or the farm is reaped/seeding
            }

            return {
                protocolId: protocol.protocol_id,
                name: protocol.name,
                status: protocol.status, // SEEDING, FARMING, REAPED
                userStatus: userStatus, // Not Involved, Contributed, Currently Farming
                // We can add estimatedShare calculation here in the future if needed
            };
        });

        res.status(200).json(responseData);

    } catch (err) {
        console.error(`Error fetching farming status for user ${userId}, vault ${vaultId}:`, err);
        res.status(500).json({ error: 'Failed to fetch farming status.' });
    } finally {
        client.release();
    }
});

module.exports = router;
