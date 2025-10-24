// ================================
// 🧩 MI STORE - BACKEND COMPLETO (2025)
// ================================

import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import { createReadStream } from "fs";
import { v2 as cloudinary } from "cloudinary";
import db from "./db.js"; // conexión PostgreSQL

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));

// ================================
// ⚙️ CONFIGURAR SESIONES
// ================================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-store-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ================================
// ☁️ CONFIGURAR CLOUDINARY
// ================================
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});
console.log("✅ Cloudinary configurado correctamente");

// ================================
// 🏠 PÁGINA PRINCIPAL
// ================================
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "./public" });
});

// ================================
// 🧑‍💼 CREAR ADMIN (solo una vez)
// ================================
app.get("/create-admin", async (req, res) => {
  try {
    const admin = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (admin.rows.length > 0) {
      return res.json({ message: "✅ Ya existe un usuario admin." });
    }

    const plainPassword = "admin123";
    const hashed = await bcrypt.hash(plainPassword, 10);

    await db.query(
      `INSERT INTO users (username, password_hash, role, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ["admin", hashed, "admin"]
    );

    console.log("✅ Admin creado correctamente.");
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
    const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);

    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Usuario no encontrado" });
    }

    const user = result.rows[0];
    const hash = user.password_hash;
    let isMatch = false;

    if (hash.startsWith("$2")) {
      isMatch = await bcrypt.compare(password, hash);
    } else {
      const check = await db.query(
        "SELECT username FROM users WHERE username=$1 AND password_hash = crypt($2, password_hash)",
        [username, password]
      );
      isMatch = check.rows.length > 0;
    }

    if (!isMatch) return res.json({ success: false, message: "Contraseña incorrecta" });

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, role: user.role });
  } catch (error) {
    console.error("❌ Error al iniciar sesión:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// ================================
// 🚀 SUBIDA DE APPS (IMAGEN + APK)
// ================================
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB máximo
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

// ================================
// ➕ CREAR APP
// ================================
app.post("/apps", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!req.files?.image || !req.files?.apk) {
      return res.status(400).json({ message: "Faltan archivos." });
    }

    console.log("📸 Subiendo archivos a Cloudinary (POST /apps)...");

    // Subir imagen
    const imagePath = req.files.image[0].path;
    const imageUpload = await cloudinary.uploader.upload(imagePath, {
      folder: "mi_store/apps",
    });

    // Subir APK
    const apkPath = req.files.apk[0].path;
    const apkUpload = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", folder: "mi_store/apks" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      createReadStream(apkPath).pipe(stream);
    });

    fs.unlinkSync(imagePath);
    fs.unlinkSync(apkPath);

    const insertResult = await db.query(
      `INSERT INTO apps (name, description, image, apk, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [name, description, imageUpload.secure_url, apkUpload.secure_url]
    );

    console.log(`✅ App '${name}' creada correctamente.`);
    res.json(insertResult.rows[0]);
  } catch (error) {
    console.error("❌ Error al crear app:", error);
    res.status(500).json({ message: "Error al crear aplicación", error: error.message });
  }
});

// ================================
// 📋 LISTAR APPS
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
// ✏️ ACTUALIZAR APP
// ================================
app.put("/apps/:id", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const appData = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (appData.rows.length === 0) {
      return res.status(404).json({ message: "App no encontrada" });
    }

    const oldApp = appData.rows[0];
    let newImage = oldApp.image;
    let newApk = oldApp.apk;

    // Subir nueva imagen (si existe)
    if (req.files?.image) {
      const imagePath = req.files.image[0].path;
      const imageUpload = await cloudinary.uploader.upload(imagePath, {
        folder: "mi_store/apps",
      });
      newImage = imageUpload.secure_url;
      fs.unlinkSync(imagePath);
    }

    // Subir nuevo APK (si existe)
    if (req.files?.apk) {
      const apkPath = req.files.apk[0].path;
      const apkUpload = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "raw", folder: "mi_store/apks" },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        createReadStream(apkPath).pipe(stream);
      });
      newApk = apkUpload.secure_url;
      fs.unlinkSync(apkPath);
    }

    const updateResult = await db.query(
      `UPDATE apps 
       SET name = $1, description = $2, image = $3, apk = $4 
       WHERE id = $5
       RETURNING *`,
      [name || oldApp.name, description || oldApp.description, newImage, newApk, id]
    );

    console.log(`✏️ App '${updateResult.rows[0].name}' actualizada correctamente.`);
    res.json({ message: "App actualizada con éxito", app: updateResult.rows[0] });
  } catch (error) {
    console.error("❌ Error al actualizar app (PUT /apps/:id):", error);
    res.status(500).json({ message: "Error al actualizar aplicación", error: error.message });
  }
});

// ================================
// 🗑️ ELIMINAR APP
// ================================
app.delete("/apps/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const appData = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (appData.rows.length === 0) {
      return res.status(404).json({ message: "App no encontrada" });
    }

    const { image, apk } = appData.rows[0];
    try {
      const imagePublicId = image.split("/").slice(-2).join("/").split(".")[0];
      const apkPublicId = apk.split("/").slice(-2).join("/").split(".")[0];
      await cloudinary.uploader.destroy(imagePublicId, { resource_type: "image" });
      await cloudinary.uploader.destroy(apkPublicId, { resource_type: "raw" });
    } catch (err) {
      console.warn("⚠️ No se pudo eliminar de Cloudinary:", err.message);
    }

    await db.query("DELETE FROM apps WHERE id = $1", [id]);
    console.log(`🗑️ App con ID ${id} eliminada correctamente.`);
    res.json({ message: "App eliminada correctamente" });
  } catch (error) {
    console.error("❌ Error al eliminar app:", error);
    res.status(500).json({ message: "Error al eliminar app", error: error.message });
  }
});

// ================================
// ⚙️ INICIAR SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
