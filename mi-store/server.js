// ================================
// 🧩 MI STORE - BACKEND COMPLETO
// ================================

import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";
import db from "./db.js"; // conexión PostgreSQL
import multer from "multer";
import fs from "fs";
import { v2 as cloudinary } from "cloudinary";

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
// ⚙️ CONFIGURAR CLOUDINARY
// ================================
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

console.log("✅ Cloudinary configurado con:", {
  cloud_name: process.env.CLOUD_NAME,
});

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

// Crear carpeta temporal para guardar archivos antes de subirlos
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configurar Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
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

// 📦 Ruta para subir app con Cloudinary
app.post("/upload", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description } = req.body;
    const imageFile = req.files["image"] ? req.files["image"][0].path : null;
    const apkFile = req.files["apk"] ? req.files["apk"][0].path : null;

    if (!name || !description || !imageFile || !apkFile) {
      return res.status(400).json({ message: "Faltan campos o archivos" });
    }

    console.log("📸 Subiendo archivos a Cloudinary...");

    // Subir imagen
    const imageUpload = await cloudinary.uploader.upload(imageFile, {
      folder: "my_store/apps",
      resource_type: "image",
    });

    // Subir APK (como tipo raw)
    const apkUpload = await cloudinary.uploader.upload(apkFile, {
      folder: "my_store/apks",
      resource_type: "raw",
    });

    // Eliminar archivos temporales locales
    fs.unlinkSync(imageFile);
    fs.unlinkSync(apkFile);

    // Guardar URLs en base de datos
    await db.query(
      `INSERT INTO apps (name, description, image, apk, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [name, description, imageUpload.secure_url, apkUpload.secure_url]
    );

    console.log(`✅ App '${name}' subida exitosamente a Cloudinary.`);
    res.json({
      message: "✅ App subida con éxito a Cloudinary",
      imageUrl: imageUpload.secure_url,
      apkUrl: apkUpload.secure_url,
    });
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
    const appData = await db.query("SELECT * FROM apps WHERE id = $1", [id]);

    if (appData.rows.length === 0) {
      return res.status(404).json({ message: "App no encontrada" });
    }

    const { image, apk } = appData.rows[0];

    // Eliminar de Cloudinary (opcional, solo si lo deseas)
    // ⚠️ Nota: Esto requiere el public_id, no solo la URL
    // Por simplicidad, este código solo elimina de la base de datos

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
