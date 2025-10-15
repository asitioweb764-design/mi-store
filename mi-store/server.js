// server.js
import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js"; // tu conexión a Postgres
import bodyParser from "body-parser";
import multer from "multer";

dotenv.config();

// Configuración base
const app = express();
const port = process.env.PORT || 3000;

// Necesario para __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-super-secreto",
    resave: false,
    saveUninitialized: false,
  })
);

// Archivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------
// RUTA: crear admin temporal
// ------------------------------
app.get("/create-admin", async (req, res) => {
  try {
    const check = await db.query("SELECT * FROM users WHERE username = $1", ["admin"]);
    if (check.rows.length > 0) {
      return res.send("✅ Ya existe un usuario admin.");
    }

    const hash = await bcrypt.hash("123456", 10);
    await db.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
      ["admin", hash, "admin"]
    );

    res.send("✅ Admin creado correctamente: usuario 'admin' / contraseña '123456'");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error al crear el admin.");
  }
});

// ------------------------------
// RUTA: verificar admins existentes
// ------------------------------
app.get("/check-admin", async (req, res) => {
  try {
    const result = await db.query("SELECT username, role FROM users WHERE role = 'admin'");
    if (result.rows.length === 0) {
      return res.send("❌ No hay ningún usuario admin en la base de datos.");
    }
    res.send(
      `✅ Admin encontrado: ${result.rows.map((u) => u.username).join(", ")} (${result.rows.length} total)`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error al consultar la base de datos.");
  }
});

// ------------------------------
// Aquí van tus demás endpoints
// (login, registro, apps, descargas, etc.)
// ------------------------------

// ------------------------------
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${port}`);
});
