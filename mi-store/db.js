// db.js — versión ESM (compatible con Render y server.js)

import pg from "pg";
const { Pool } = pg;

// Crea un pool de conexiones PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 👇 ESTA LÍNEA ES LA CLAVE: exporta el pool como "default"
export default pool;
