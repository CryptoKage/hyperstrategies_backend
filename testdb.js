const fs = require('fs');
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync('./local/rds-ca.pem').toString(), // ✅ same path here
    }
  });

  try {
    await client.connect();
    const res = await client.query("SELECT version();");
    console.log("Connected to:", res.rows[0]);
  } catch (err) {
    console.error("DB connect fail:", err);
  } finally {
    await client.end();
  }
})();
