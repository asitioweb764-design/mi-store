// db.js (versión ESM para Render + PostgreSQL)

import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Exporta el pool como "default"
export default pool;
