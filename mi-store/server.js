// ================================
// 🧩 MI STORE - BACKEND COMPLETO (v2)
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
import db from "./db.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));

// ================================
// ⚙️ SESIONES
// ================================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-store-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ================================
// ☁️ CLOUDINARY
// ================================
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

// ================================
// 🏠 PÁGINA PRINCIPAL
// ================================
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "./public" });
});

// ================================
// 🧑‍💼 CREAR ADMIN
// ================================
app.get("/create-admin", async (req, res) => {
  try {
    const admin = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (admin.rows.length > 0)
      return res.json({ message: "✅ Ya existe un usuario admin." });

    const hashed = await bcrypt.hash("admin123", 10);
    await db.query(
      `INSERT INTO users (username, password_hash, role, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ["admin", hashed, "admin"]
    );

    res.json({
      message: "✅ Admin creado (usuario: admin / contraseña: admin123)",
    });
  } catch (error) {
    res.status(500).json({ message: "Error al crear admin", error: error.message });
  }
});

// ================================
// 🔐 LOGIN
// ================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.query("SELECT * FROM users WHERE username=$1", [username]);
    if (result.rows.length === 0)
      return res.json({ success: false, message: "Usuario no encontrado" });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch)
      return res.json({ success: false, message: "Contraseña incorrecta" });

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, role: user.role });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// ================================
// 🚀 SUBIDA Y GESTIÓN DE APPS
// ================================

const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_")),
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype === "application/vnd.android.package-archive"
    ) cb(null, true);
    else cb(new Error("Tipo de archivo no permitido"));
  },
});

// Crear app (POST /apps)
app.post("/apps", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description, category, is_paid } = req.body;
    if (!req.files?.image || !req.files?.apk)
      return res.status(400).json({ message: "Faltan archivos." });

    const imageUpload = await cloudinary.uploader.upload(req.files.image[0].path, {
      folder: "mi_store/apps",
    });

    const apkUpload = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", folder: "mi_store/apks" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      createReadStream(req.files.apk[0].path).pipe(stream);
    });

    fs.unlinkSync(req.files.image[0].path);
    fs.unlinkSync(req.files.apk[0].path);

    await db.query(
      `INSERT INTO apps (name, description, image, apk, category, is_paid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [name, description, imageUpload.secure_url, apkUpload.secure_url, category, is_paid === "true"]
    );

    res.json({ message: "✅ App creada con éxito" });
  } catch (error) {
    res.status(500).json({ message: "Error al subir aplicación", error: error.message });
  }
});

// Actualizar app (PUT /apps/:id)
app.put("/apps/:id", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, is_paid } = req.body;

    const oldApp = await db.query("SELECT * FROM apps WHERE id=$1", [id]);
    if (oldApp.rows.length === 0)
      return res.status(404).json({ message: "App no encontrada" });

    const appData = oldApp.rows[0];
    let imageUrl = appData.image;
    let apkUrl = appData.apk;

    if (req.files?.image) {
      const img = await cloudinary.uploader.upload(req.files.image[0].path, {
        folder: "mi_store/apps",
      });
      imageUrl = img.secure_url;
      fs.unlinkSync(req.files.image[0].path);
    }

    if (req.files?.apk) {
      const apk = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "raw", folder: "mi_store/apks" },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        createReadStream(req.files.apk[0].path).pipe(stream);
      });
      apkUrl = apk.secure_url;
      fs.unlinkSync(req.files.apk[0].path);
    }

    await db.query(
      `UPDATE apps SET
        name=$1, description=$2, image=$3, apk=$4, category=$5, is_paid=$6, updated_at=NOW()
       WHERE id=$7`,
      [
        name || appData.name,
        description || appData.description,
        imageUrl,
        apkUrl,
        category || appData.category,
        is_paid !== undefined ? is_paid === "true" : appData.is_paid,
        id,
      ]
    );

    res.json({ message: "✅ App actualizada correctamente" });
  } catch (error) {
    res.status(500).json({ message: "Error al actualizar app", error: error.message });
  }
});

// ================================
// 📋 LISTAR Y ELIMINAR APPS
// ================================
app.get("/api/apps", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM apps ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener apps" });
  }
});

app.delete("/apps/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("DELETE FROM apps WHERE id=$1", [id]);
    res.json({ message: "🗑️ App eliminada correctamente" });
  } catch (error) {
    res.status(500).json({ message: "Error al eliminar app", error: error.message });
  }
});

// ================================
// 🌟 RESEÑAS Y VALORACIONES
// ================================
app.get("/api/apps/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "SELECT username, rating, comment, created_at FROM reviews WHERE app_id=$1 ORDER BY created_at DESC",
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener reseñas" });
  }
});

app.post("/api/apps/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;
    const { username, rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ message: "Valoración inválida" });

    await db.query(
      "INSERT INTO reviews (app_id, username, rating, comment) VALUES ($1,$2,$3,$4)",
      [id, username || "Anónimo", rating, comment || ""]
    );

    const avg = await db.query(
      "SELECT ROUND(AVG(rating),1) AS avg_rating FROM reviews WHERE app_id=$1",
      [id]
    );
    await db.query("UPDATE apps SET rating=$1 WHERE id=$2", [avg.rows[0].avg_rating, id]);

    res.json({ message: "✅ Reseña añadida" });
  } catch (error) {
    res.status(500).json({ message: "Error al agregar reseña" });
  }
});

// ================================
// ⭐ VALORACIONES DE APPS
// ================================

// Crear o actualizar una valoración
app.post("/api/ratings", async (req, res) => {
  try {
    const { user_id, app_id, rating } = req.body;

    if (!user_id || !app_id || !rating) {
      return res.status(400).json({ message: "Faltan datos requeridos." });
    }

    // Verificar si el usuario ya valoró esta app
    const existing = await db.query(
      "SELECT id FROM ratings WHERE user_id = $1 AND app_id = $2",
      [user_id, app_id]
    );

    if (existing.rows.length > 0) {
      // Actualizar valoración existente
      await db.query(
        "UPDATE ratings SET rating = $1, created_at = NOW() WHERE user_id = $2 AND app_id = $3",
        [rating, user_id, app_id]
      );
    } else {
      // Crear nueva valoración
      await db.query(
        "INSERT INTO ratings (user_id, app_id, rating, created_at) VALUES ($1, $2, $3, NOW())",
        [user_id, app_id, rating]
      );
    }

    // Recalcular promedio y actualizar en apps
    const avgRes = await db.query(
      "SELECT ROUND(AVG(rating)::numeric, 1) AS avg FROM ratings WHERE app_id = $1",
      [app_id]
    );
    const avg = avgRes.rows[0].avg || 0;

    await db.query("UPDATE apps SET rating = $1 WHERE id = $2", [avg, app_id]);

    res.json({ message: "Valoración guardada correctamente", average: avg });
  } catch (error) {
    console.error("❌ Error al guardar valoración:", error);
    res.status(500).json({ message: "Error al guardar valoración", error: error.message });
  }
});

// Obtener promedio y total de valoraciones por app
app.get("/api/ratings/:appId", async (req, res) => {
  try {
    const { appId } = req.params;
    const result = await db.query(
      `SELECT 
        COALESCE(ROUND(AVG(rating)::numeric, 1), 0) AS average_rating,
        COUNT(id) AS total_ratings
       FROM ratings WHERE app_id = $1`,
      [appId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error al obtener valoraciones:", error);
    res.status(500).json({ message: "Error al obtener valoraciones", error: error.message });
  }
});


// ================================
// 🚀 INICIAR SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en el puerto ${PORT}`));

