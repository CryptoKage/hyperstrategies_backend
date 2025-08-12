// FILE: hyperstrategies_backend/routes/adminPins.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const isAdmin = require('../middleware/isAdmin');

// Middleware to ensure only admins can access these routes
router.use(authenticateToken, isAdmin);

// GET /api/admin/pins/search-users?query=...
// Search for users by username or email
router.get('/search-users', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) return res.json([]);
    try {
        const result = await pool.query(
            "SELECT id, username, email FROM users WHERE username ILIKE $1 OR email ILIKE $1 LIMIT 10",
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Admin user search error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/admin/pins/user/:userId
// Get a specific user's current pins
router.get('/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query("SELECT pin_name FROM user_pins WHERE user_id = $1", [userId]);
        res.json(result.rows.map(r => r.pin_name));
    } catch (error) {
        console.error("Admin get user pins error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/admin/pins/assign
// Assign a pin to a user
router.post('/assign', async (req, res) => {
    const { userId, pinName } = req.body;
    try {
        await pool.query("INSERT INTO user_pins (user_id, pin_name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, pinName]);
        res.status(200).json({ message: `Pin '${pinName}' assigned to user ${userId}.` });
    } catch (error) {
        console.error("Admin assign pin error:", error);
        res.status(500).json({ message: "Failed to assign pin." });
    }
});

// POST /api/admin/pins/revoke
// Revoke a pin from a user
router.post('/revoke', async (req, res) => {
    const { userId, pinName } = req.body;
    try {
        await pool.query("DELETE FROM user_pins WHERE user_id = $1 AND pin_name = $2", [userId, pinName]);
        res.status(200).json({ message: `Pin '${pinName}' revoked from user ${userId}.` });
    } catch (error) {
        console.error("Admin revoke pin error:", error);
        res.status(500).json({ message: "Failed to revoke pin." });
    }
});

module.exports = router;
