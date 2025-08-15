// hyperstrategies_backend/routes/adminPins.js
// FINAL VERSION: Refactored to work with the unique 'pins' table.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');

router.use(authenticateToken, isAdmin);

// Search for users (no change needed here, but corrected to use user_id)
router.get('/search-users', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) return res.json([]);
    try {
        const result = await pool.query(
            "SELECT user_id as id, username, email FROM users WHERE username ILIKE $1 OR email ILIKE $1 LIMIT 10",
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Admin user search error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// Get a specific user's current pins from the new 'pins' table
router.get('/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            "SELECT pin_id, pin_name, mint_date FROM pins WHERE owner_id = $1 ORDER BY mint_date DESC", 
            [userId]
        );
        res.json(result.rows); // Returns an array of objects: { pin_id, pin_name, mint_date }
    } catch (error) {
        console.error("Admin get user pins error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// NEW "Mint" endpoint to create a unique pin instance
router.post('/mint', async (req, res) => {
    const { userId, pinName } = req.body;
    if (!userId || !pinName) {
        return res.status(400).json({ message: "userId and pinName are required." });
    }
    try {
        const result = await pool.query(
            'INSERT INTO pins (owner_id, pin_name) VALUES ($1, $2) RETURNING *',
            [userId, pinName]
        );
        res.status(201).json({ message: `Successfully minted '${pinName}' pin for user ${userId}.`, newPin: result.rows[0] });
    } catch (error) {
        console.error("Admin mint pin error:", error);
        res.status(500).json({ message: "Failed to mint pin." });
    }
});

// Updated "Revoke" endpoint to delete a pin by its unique pin_id
router.post('/revoke', async (req, res) => {
    const { pinId } = req.body; // We now use the unique pin_id
    if (!pinId) {
        return res.status(400).json({ message: "pinId is required." });
    }
    try {
        await pool.query("DELETE FROM pins WHERE pin_id = $1", [pinId]);
        res.status(200).json({ message: `Pin ID ${pinId} has been revoked.` });
    } catch (error) {
        console.error("Admin revoke pin error:", error);
        res.status(500).json({ message: "Failed to revoke pin." });
    }
});

module.exports = router;
