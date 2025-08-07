// db.js

const fs = require('fs');
const path = require('path'); // <-- Import the 'path' module
const { Pool } = require('pg');
require('dotenv').config();

// --- NEW: Check if we are in a production environment ---
const isProduction = process.env.NODE_ENV === 'production';

// --- NEW: Define the base configuration ---
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

// --- NEW: Conditionally add SSL configuration only for production ---
if (isProduction) {
  // Use path.join to create a reliable path to the certificate file
  const caPath = path.join(__dirname, 'local', 'rds-ca.pem');
  
  dbConfig.ssl = {
    rejectUnauthorized: true,
    ca: fs.readFileSync(caPath).toString(),
  };
}

// Create the pool with the final configuration
const pool = new Pool(dbConfig);

module.exports = pool;
