// server.js
// ================================
// 🧩 MI STORE - BACKEND COMPLETO (actualizado)
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

// CORS: ajusta origins en .env si lo necesitas
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : true,
    credentials: true,
  })
);

// servir estáticos (frontend)
app.use(express.static("public"));

// ================================
// ⚙️ CONFIGURAR SESIONES
// ================================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-store-secret",
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
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
// 🧑‍💼 CREAR ADMIN (route útil para inicializar)
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
    if (hash && hash.startsWith("$2")) {
      isMatch = await bcrypt.compare(password, hash);
    } else {
      // fallback a crypt() if tu DB lo usa
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

// Crear carpeta temporal
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Configurar Multer (guardamos en disco temporalmente)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB máximo por archivo (ajusta según necesidad)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/vnd.android.package-archive" || file.originalname.endsWith(".apk")) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de archivo no permitido"));
    }
  },
});

// Helper: subir APK a Cloudinary como raw (stream) y/o subir imagen
async function uploadImageToCloudinaryLocal(filePath) {
  return await cloudinary.uploader.upload(filePath, { folder: "mi_store/apps" });
}
async function uploadRawToCloudinaryStream(filePath) {
  return await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: "raw", folder: "mi_store/apks" }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    createReadStream(filePath).pipe(stream);
  });
}

// ROUTE: legacy /upload (mantener si lo usas)
app.post("/upload", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!req.files?.image || !req.files?.apk) {
      return res.status(400).json({ message: "Faltan archivos." });
    }

    console.log("📸 Subiendo archivos a Cloudinary... (/upload)");

    // Subir imagen
    const imagePath = req.files.image[0].path;
    const imageUpload = await uploadImageToCloudinaryLocal(imagePath);

    // Subir APK (raw)
    const apkPath = req.files.apk[0].path;
    const apkUpload = await uploadRawToCloudinaryStream(apkPath);

    // Eliminar temporales
    try { fs.unlinkSync(imagePath); } catch {}
    try { fs.unlinkSync(apkPath); } catch {}

    // Guardar en DB
    await db.query(
      `INSERT INTO apps (name, description, image, apk, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [name, description, imageUpload.secure_url, apkUpload.secure_url]
    );

    console.log(`✅ App '${name}' subida correctamente. (/upload)`);
    res.json({ message: "App subida con éxito" });
  } catch (error) {
    console.error("❌ Error al subir app (/upload):", error);
    res.status(500).json({ message: "Error al subir aplicación", error: error.message });
  }
});

// ================================
// ➕ CREAR APP (POST /apps) <- requerido por frontend
// ================================
app.post("/apps", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !description) {
      return res.status(400).json({ message: "Nombre y descripción son obligatorios." });
    }

    // Nota: aceptamos que la imagen o apk sean opcionales dependiendo de tu flujo.
    let imageUrl = null;
    let apkUrl = null;

    if (req.files?.image && req.files.image[0]) {
      const imagePath = req.files.image[0].path;
      const imageUpload = await uploadImageToCloudinaryLocal(imagePath);
      imageUrl = imageUpload.secure_url;
      try { fs.unlinkSync(imagePath); } catch {}
    }

    if (req.files?.apk && req.files.apk[0]) {
      const apkPath = req.files.apk[0].path;
      const apkUpload = await uploadRawToCloudinaryStream(apkPath);
      apkUrl = apkUpload.secure_url;
      try { fs.unlinkSync(apkPath); } catch {}
    }

    const insertResult = await db.query(
      `INSERT INTO apps (name, description, image, apk, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [name, description, imageUrl, apkUrl]
    );

    const newApp = insertResult.rows[0];
    console.log(`✅ App '${name}' creada correctamente. (POST /apps)`);
    res.json(newApp);
  } catch (error) {
    console.error("❌ Error al crear app (POST /apps):", error);
    res.status(500).json({ message: "Error al crear aplicación", error: error.message });
  }
});

// ================================
// ✏️ EDITAR APP (PUT /apps/:id) <- para editar desde modal
// ================================
app.put("/apps/:id", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "ID inválido" });

    // Verificar existencia
    const existingRes = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) return res.status(404).json({ message: "App no encontrada" });
    const existing = existingRes.rows[0];

    // Campos a actualizar
    const { name, description } = req.body;
    const updates = {
      name: name ?? existing.name,
      description: description ?? existing.description,
      image: existing.image,
      apk: existing.apk,
      updated_at: new Date(),
    };

    // Si viene nueva imagen -> subir y reemplazar
    if (req.files?.image && req.files.image[0]) {
      const imagePath = req.files.image[0].path;
      const imageUpload = await uploadImageToCloudinaryLocal(imagePath);
      updates.image = imageUpload.secure_url;
      try { fs.unlinkSync(imagePath); } catch {}
      // opcional: eliminar imagen anterior de Cloudinary (si tienes public_id)
      // nota: eliminar anterior puede fallar si no obtuviste public_id; puedes mejorar guardando public_id en BD.
    }

    // Si viene nuevo APK -> subir y reemplazar
    if (req.files?.apk && req.files.apk[0]) {
      const apkPath = req.files.apk[0].path;
      const apkUpload = await uploadRawToCloudinaryStream(apkPath);
      updates.apk = apkUpload.secure_url;
      try { fs.unlinkSync(apkPath); } catch {}
    }

    // UPDATE en DB
    const updateRes = await db.query(
      `UPDATE apps SET name=$1, description=$2, image=$3, apk=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
      [updates.name, updates.description, updates.image, updates.apk, id]
    );

    const updated = updateRes.rows[0];
    console.log(`✏️ App ID ${id} actualizada correctamente. (PUT /apps/${id})`);
    res.json(updated);
  } catch (error) {
    console.error("❌ Error al actualizar app (PUT /apps/:id):", error);
    res.status(500).json({ message: "Error al actualizar app", error: error.message });
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

    // Intentamos eliminar de Cloudinary (siempre en try/catch)
    try {
      if (image) {
        // intenta extraer public_id; puede variar según cómo se subió
        const imagePublicId = image.split("/").slice(-2).join("/").split(".")[0];
        await cloudinary.uploader.destroy(imagePublicId, { resource_type: "image" });
      }
      if (apk) {
        const apkPublicId = apk.split("/").slice(-2).join("/").split(".")[0];
        await cloudinary.uploader.destroy(apkPublicId, { resource_type: "raw" });
      }
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
