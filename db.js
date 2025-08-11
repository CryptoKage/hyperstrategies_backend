// db.js

const fs = require('fs');
const path = require('path'); // <-- Import the 'path' module
const { Pool } = require('pg');
require('dotenv').config();

// --- Ensure all required environment variables are present ---
const requiredEnvVars = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_DATABASE',
];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`FATAL ERROR: ${key} environment variable is not defined.`);
  }
}

// --- Check if we are in a production environment ---
const isProduction = process.env.NODE_ENV === 'production';

// --- Define the base configuration ---
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

// Log the configuration (excluding the password) at startup
const { password, ...sanitizedConfig } = dbConfig;
console.log('Database configuration loaded:', sanitizedConfig);

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
