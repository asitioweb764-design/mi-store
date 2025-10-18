// server.js
import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import dbModule from "./db.js";
const db = dbModule.default || dbModule;
import bodyParser from "body-parser";
import multer from "multer";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configuración de Multer (para manejar archivos en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });


dotenv.config();

// Configuración base
const app = express();
const port = process.env.PORT || 3000;

// Necesario para obtener __dirname en ESM
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

// Archivos estáticos (frontend)
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------
// 🧱 INICIALIZAR BASE DE DATOS
// ------------------------------
const initDB = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user'
      )
    `);
    console.log("🗄️ Tabla 'users' verificada o creada correctamente");
  } catch (err) {
    console.error("❌ Error inicializando base de datos:", err);
  }
};

// Ejecutar inicialización
initDB();

// ------------------------------
// 🧱 Inicializar tabla de apps
// ------------------------------
const initAppsTable = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        image_url TEXT,
        file_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("📱 Tabla 'apps' verificada o creada correctamente");
  } catch (err) {
    console.error("❌ Error creando tabla 'apps':", err);
  }
};

initAppsTable();

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
    console.error("❌ Error al crear el admin:", err);
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
    console.error("❌ Error al consultar la base de datos:", err);
    res.status(500).send("❌ Error al consultar la base de datos.");
  }
});
// ------------------------------
// RUTA TEMPORAL: reparar tabla users
// ------------------------------
app.get("/fix-users-table", async (req, res) => {
  try {
    await db.query(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`);
    res.send("✅ Columna 'role' agregada correctamente a la tabla 'users'.");
  } catch (err) {
    if (err.code === "42701") {
      // columna ya existe
      res.send("ℹ️ La columna 'role' ya existe, no se hizo nada.");
    } else {
      console.error(err);
      res.status(500).send("❌ Error al modificar la tabla: " + err.message);
    }
  }
});

// ------------------------------
// 🔑 LOGIN
// ------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Usuario no encontrado" });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    }

    // Guardar sesión
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    res.json({ success: true, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// ------------------------------
// 🚪 LOGOUT
// ------------------------------
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// ------------------------------
// 🔐 RUTA PROTEGIDA DE EJEMPLO
// ------------------------------
app.get("/api/admin/check", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "No autenticado" });
  }
  if (req.session.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "No autorizado" });
  }
  res.json({ success: true, message: "Bienvenido, administrador" });
});

// ------------------------------
// 📦 API: CRUD de apps
// ------------------------------

// (1) Obtener todas las apps
app.get("/api/apps", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM apps ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener las apps" });
  }
});

// (2) Subir una nueva app
app.post("/api/apps", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { name, description, image_url, file_url } = req.body;
    await db.query(
      "INSERT INTO apps (name, description, image_url, file_url) VALUES ($1, $2, $3, $4)",
      [name, description, image_url, file_url]
    );

    res.json({ success: true, message: "App agregada correctamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al subir la app" });
  }
});

// (3) Eliminar una app
app.delete("/api/apps/:id", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    await db.query("DELETE FROM apps WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar la app" });
  }
});

// ------------------------------
// INICIO DEL SERVIDOR
// ------------------------------
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${port}`);
});








