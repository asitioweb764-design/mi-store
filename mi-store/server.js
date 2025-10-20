// ================================
// 🧩 MI STORE - BACKEND COMPLETO
// ================================

import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";
import db from "./db.js"; // conexión PostgreSQL

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));

// 🧠 Configuración de sesiones
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-store-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ================================
// 📦 RUTAS PRINCIPALES
// ================================

// 🏠 Página principal
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "./public" });
});

// ================================
// 🧑‍💼 CREAR ADMIN
// ================================
app.get("/create-admin", async (req, res) => {
  try {
    console.log("🛠️ Intentando crear usuario admin...");

    const admin = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (admin.rows.length > 0) {
      console.log("ℹ️ Ya existe un admin, no se crea otro.");
      return res.json({ message: "✅ Ya existe un usuario admin." });
    }

    const plainPassword = "admin123";
    const hashed = await bcrypt.hash(plainPassword, 10);

    await db.query(
      `INSERT INTO users (username, password_hash, role, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ["admin", hashed, "admin"]
    );

    console.log("✅ Admin insertado correctamente en la base de datos.");
    res.json({
      message: "✅ Usuario admin creado (usuario: admin / contraseña: admin123)",
    });
  } catch (error) {
    console.error("❌ Error al crear admin:", error);
    res.status(500).json({ message: "Error al crear admin", error: error.message });
  }
});

// ================================
// 🔐 LOGIN
// ================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Buscar usuario
    const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Usuario no encontrado" });
    }

    const user = result.rows[0];
    const hash = user.password_hash;

    if (!hash) {
      console.error("⚠️ Usuario sin hash de contraseña:", user.username);
      return res.json({ success: false, message: "Error interno: sin contraseña" });
    }

    // Detectar tipo de hash y comparar
    let isMatch = false;
    if (hash.startsWith("$2")) {
      // bcrypt
      isMatch = await bcrypt.compare(password, hash);
    } else {
      // pgcrypto
      const check = await db.query(
        "SELECT username FROM users WHERE username=$1 AND password_hash = crypt($2, password_hash)",
        [username, password]
      );
      isMatch = check.rows.length > 0;
    }

    if (!isMatch) {
      return res.json({ success: false, message: "Contraseña incorrecta" });
    }

    // Guardar sesión
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, role: user.role });
  } catch (error) {
    console.error("❌ Error al iniciar sesión:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// ================================
// 🧩 VERIFICAR ADMIN
// ================================
app.get("/check-admin", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (result.rows.length === 0) {
      return res.send("❌ No hay ningún usuario admin en la base de datos.");
    } else {
      return res.send("✅ Admin existente en la base de datos.");
    }
  } catch (error) {
    console.error("❌ Error al consultar la base de datos:", error);
    res.send("❌ Error al consultar la base de datos.");
  }
});

// ================================
// 🚀 SUBIDA DE APPS (IMAGEN + APK)
// ================================
import multer from "multer";
import fs from "fs";
import path from "path";

// Crear carpeta para guardar archivos si no existe
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configurar Multer para subir imágenes y APKs
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // máximo 15MB
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype === "application/vnd.android.package-archive"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de archivo no permitido"));
    }
  },
});

// 📦 Ruta para subir app
app.post("/upload", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description } = req.body;
    const imageFile = req.files["image"] ? req.files["image"][0].filename : null;
    const apkFile = req.files["apk"] ? req.files["apk"][0].filename : null;

    if (!name || !description || !imageFile || !apkFile) {
      return res.status(400).json({ message: "Faltan campos o archivos" });
    }

    // Guardar en base de datos
    await db.query(
      `INSERT INTO apps (name, description, image, apk, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [name, description, imageFile, apkFile]
    );

    console.log(`✅ App '${name}' subida correctamente.`);
    res.json({ message: "App subida con éxito" });
  } catch (error) {
    console.error("❌ Error al subir app:", error);
    res.status(500).json({ message: "Error al subir aplicación", error: error.message });
  }
});

// ================================
// 📋 LISTAR APPS (para el admin)
// ================================
app.get("/api/apps", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM apps ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error al obtener apps:", error);
    res.status(500).json({ message: "Error al obtener apps" });
  }
});


// ================================
// 🗑️ ELIMINAR APLICACIONES
// ================================
app.delete("/apps/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar si la app existe
    const appData = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (appData.rows.length === 0) {
      return res.status(404).json({ message: "App no encontrada" });
    }

    // Eliminar los archivos físicos (imagen y apk)
    const { image, apk } = appData.rows[0];
    const imagePath = `./uploads/${image}`;
    const apkPath = `./uploads/${apk}`;

    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);

    // Eliminar de la base de datos
    await db.query("DELETE FROM apps WHERE id = $1", [id]);

    console.log(`🗑️ App con ID ${id} eliminada correctamente.`);
    res.json({ message: "App eliminada correctamente" });
  } catch (error) {
    console.error("❌ Error al eliminar app:", error);
    res.status(500).json({ message: "Error al eliminar app", error: error.message });
  }
});


// ================================
// ⚙️ CONFIGURACIÓN DEL SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});



