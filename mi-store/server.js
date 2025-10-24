// server.js (completo, actualizado)
// ================================
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import { createReadStream } from "fs";
import { v2 as cloudinary } from "cloudinary";
import db from "./db.js"; // tu cliente pg - debe exportar pool.query

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : true,
    credentials: true,
  })
);

app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "mi-store-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production" },
  })
);

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});
console.log("✅ Cloudinary configurado");

// Multer (temp dir)
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_")),
});
const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.originalname.endsWith(".apk") || file.mimetype === "application/vnd.android.package-archive") cb(null, true);
    else cb(new Error("Tipo de archivo no permitido"));
  },
});

// helpers cloudinary
async function uploadImage(path) {
  return cloudinary.uploader.upload(path, { folder: "mi_store/apps" });
}
async function uploadRaw(path) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: "raw", folder: "mi_store/apks" }, (err, res) => (err ? reject(err) : resolve(res)));
    createReadStream(path).pipe(stream);
  });
}

// --------------------
// Rutas: categorias
// --------------------

// GET listar categorías
app.get("/api/categories", async (req, res) => {
  try {
    const r = await db.query("SELECT id, name FROM categories ORDER BY name");
    res.json(r.rows);
  } catch (err) {
    console.error("Error GET /api/categories", err);
    res.status(500).json({ message: "Error al obtener categorías" });
  }
});

// POST crear categoría
app.post("/api/categories", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ message: "Nombre requerido" });
    const r = await db.query("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *", [name.trim()]);
    if (r.rows.length === 0) {
      return res.status(409).json({ message: "La categoría ya existe" });
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("Error POST /api/categories", err);
    res.status(500).json({ message: "Error al crear categoría" });
  }
});

// DELETE categoría
app.delete("/api/categories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "ID inválido" });

    // Opcional: si hay apps con esa categoría, puedes decidir si permitir borrado o no.
    // Aquí simplemente permitimos borrarlo (las apps mantendrán category_id = null).
    await db.query("UPDATE apps SET category_id = NULL WHERE category_id = $1", [id]);
    await db.query("DELETE FROM categories WHERE id = $1", [id]);
    res.json({ message: "Categoría eliminada" });
  } catch (err) {
    console.error("Error DELETE /api/categories/:id", err);
    res.status(500).json({ message: "Error al eliminar categoría" });
  }
});

// --------------------
// Rutas: apps (CRUD)
// --------------------

// GET /api/apps -> lista con JOIN de categoría
app.get("/api/apps", async (req, res) => {
  try {
    const query = `
      SELECT a.*, c.id AS category_id, c.name AS category_name
      FROM apps a
      LEFT JOIN categories c ON a.category_id = c.id
      ORDER BY a.created_at DESC
    `;
    const r = await db.query(query);
    // devolver rows (cada row ya contiene category_id y category_name)
    res.json(r.rows);
  } catch (err) {
    console.error("Error GET /api/apps", err);
    res.status(500).json({ message: "Error al obtener apps" });
  }
});

// POST /apps -> crear app (acepta category_id e is_paid)
app.post("/apps", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const { name, description, category_id } = req.body;
    // is_paid puede venir como 'true'/'false' o 'on' o '1'
    const isPaidRaw = req.body.is_paid;
    const is_paid = isPaidRaw === "true" || isPaidRaw === "1" || isPaidRaw === "on" ? true : false;

    if (!name) return res.status(400).json({ message: "Nombre requerido" });
    // subir archivos si vienen
    let imageUrl = null, apkUrl = null;

    if (req.files?.image && req.files.image[0]) {
      const p = req.files.image[0].path;
      const up = await uploadImage(p);
      imageUrl = up.secure_url;
      try { fs.unlinkSync(p); } catch {}
    }
    if (req.files?.apk && req.files.apk[0]) {
      const p = req.files.apk[0].path;
      const up = await uploadRaw(p);
      apkUrl = up.secure_url;
      try { fs.unlinkSync(p); } catch {}
    }

    const insert = await db.query(
      `INSERT INTO apps (name, description, image, apk, category_id, is_paid, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [name, description || null, imageUrl, apkUrl, category_id ? parseInt(category_id,10) : null, is_paid]
    );
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("Error POST /apps", err);
    res.status(500).json({ message: "Error al crear app", error: err.message });
  }
});

// PUT /apps/:id -> editar app (opcionalmente archivos y category_id + is_paid)
app.put("/apps/:id", upload.fields([{ name: "image" }, { name: "apk" }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, category_id } = req.body;
    const isPaidRaw = req.body.is_paid;
    const is_paid = isPaidRaw === "true" || isPaidRaw === "1" || isPaidRaw === "on" ? true : false;

    if (Number.isNaN(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (r.rows.length === 0) return res.status(404).json({ message: "App no encontrada" });
    const old = r.rows[0];

    let imageUrl = old.image;
    let apkUrl = old.apk;

    if (req.files?.image && req.files.image[0]) {
      const p = req.files.image[0].path;
      const up = await uploadImage(p);
      imageUrl = up.secure_url;
      try { fs.unlinkSync(p); } catch {}
      // opcional: eliminar anterior (requiere public_id almacenado)
    }
    if (req.files?.apk && req.files.apk[0]) {
      const p = req.files.apk[0].path;
      const up = await uploadRaw(p);
      apkUrl = up.secure_url;
      try { fs.unlinkSync(p); } catch {}
    }

    const update = await db.query(
      `UPDATE apps SET name=$1, description=$2, image=$3, apk=$4, category_id=$5, is_paid=$6 WHERE id=$7 RETURNING *`,
      [
        name && name.trim() ? name : old.name,
        description !== undefined ? description : old.description,
        imageUrl,
        apkUrl,
        category_id ? parseInt(category_id,10) : old.category_id,
        is_paid,
        id
      ]
    );

    res.json(update.rows[0]);
  } catch (err) {
    console.error("Error PUT /apps/:id", err);
    res.status(500).json({ message: "Error al actualizar app", error: err.message });
  }
});

// DELETE /apps/:id
app.delete("/apps/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await db.query("SELECT * FROM apps WHERE id = $1", [id]);
    if (r.rows.length === 0) return res.status(404).json({ message: "App no encontrada" });
    const item = r.rows[0];

    // intentar eliminar de cloudinary (no crítico)
    try {
      if (item.image) {
        const pid = item.image.split("/").slice(-2).join("/").split(".")[0];
        await cloudinary.uploader.destroy(pid, { resource_type: "image" });
      }
      if (item.apk) {
        const pid = item.apk.split("/").slice(-2).join("/").split(".")[0];
        await cloudinary.uploader.destroy(pid, { resource_type: "raw" });
      }
    } catch (e) { console.warn("No se pudo eliminar archivo en Cloudinary:", e.message); }

    await db.query("DELETE FROM apps WHERE id = $1", [id]);
    res.json({ message: "App eliminada" });
  } catch (err) {
    console.error("Error DELETE /apps/:id", err);
    res.status(500).json({ message: "Error al eliminar app", error: err.message });
  }
});

// Simple health
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
