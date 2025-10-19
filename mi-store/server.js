import express from "express";
import session from "express-session";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";
import bcrypt from "bcrypt";
import dbModule from "./db.js";

const app = express();
const db = dbModule;

// ✅ Middleware básico
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ⚙️ Sesión temporal
app.use(
  session({
    secret: "mi-store-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ⚙️ Multer en memoria
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ☁️ Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🧱 Crear tablas si no existen
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS apps (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      image_url TEXT,
      file_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user'
    );
  `);

  console.log("📱 Tabla 'apps' verificada o creada correctamente");
  console.log("🗄️ Tabla 'users' verificada o creada correctamente");
})();

// 🧑‍💼 Crear admin
app.get("/create-admin", async (req, res) => {
  try {
    const admin = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (admin.rows.length > 0)
      return res.json({ message: "✅ Ya existe un usuario admin." });

    const hashed = await bcrypt.hash("admin123", 10);
    await db.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin')",
      ["admin", hashed]
    );
    res.json({
      message: "✅ Usuario admin creado (usuario: admin / contraseña: admin123)",
    });
  } catch (error) {
    console.error("❌ Error al crear admin:", error);
    res.status(500).json({ message: "Error al crear admin" });
  }
});

// 🧑‍💻 Login del admin
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({ success: false, message: "Faltan credenciales" });
    }

    const result = await db.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Usuario no encontrado" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.json({ success: false, message: "Contraseña incorrecta" });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, message: "Inicio de sesión exitoso", role: user.role });
  } catch (error) {
    console.error("❌ Error al iniciar sesión:", error);
    res.json({ success: false, message: "Error interno del servidor" });
  }
});

// 📦 Subida de apps (imagen + APK)
app.post(
  "/upload-app",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, description } = req.body;
      const imageFile = req.files?.image?.[0];
      const apkFile = req.files?.file?.[0];

      if (!imageFile) {
        return res.status(400).json({ message: "Falta la imagen de la app." });
      }

      // 📤 Subir imagen
      const uploadImage = new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "mi-store/apps" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        streamifier.createReadStream(imageFile.buffer).pipe(uploadStream);
      });

      // 📦 Subir APK
      const uploadFile = apkFile
        ? new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              { folder: "mi-store/files", resource_type: "raw" },
              (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
              }
            );
            streamifier.createReadStream(apkFile.buffer).pipe(uploadStream);
          })
        : Promise.resolve(null);

      const [image_url, file_url] = await Promise.all([
        uploadImage,
        uploadFile,
      ]);

      await db.query(
        "INSERT INTO apps (name, description, image_url, file_url) VALUES ($1, $2, $3, $4)",
        [name, description, image_url, file_url]
      );

      res.json({ message: "✅ App agregada correctamente" });
    } catch (error) {
      console.error("❌ Error subiendo archivo:", error);
      res.status(500).json({ message: "Error al subir app", error: error.message });
    }
  }
);

// 📋 Listar apps
app.get("/api/apps", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, name, description, image_url, file_url FROM apps ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error al obtener apps:", error);
    res.status(500).json({ message: "Error al obtener apps" });
  }
});

// 🌐 Página principal
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// 🚀 Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
