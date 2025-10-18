import express from "express";
import session from "express-session";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";
import dbModule from "./db.js";

const app = express();
const db = dbModule;

// ✅ Middleware básico
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ⚙️ Sesión temporal (solo para desarrollo)
app.use(
  session({
    secret: "mi-store-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// 🧰 Configurar Multer (archivos en memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ☁️ Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🧱 Verificar o crear tablas automáticamente
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

// 🧩 Subir imagen y APK
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

      // 📤 Subir imagen a Cloudinary
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

      // 📦 Subir archivo APK si existe
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

      // 💾 Guardar en PostgreSQL
      await db.query(
        `INSERT INTO apps (name, description, image_url, file_url)
         VALUES ($1, $2, $3, $4)`,
        [name, description, image_url, file_url]
      );

      res.json({ message: "✅ App agregada correctamente" });
    } catch (error) {
      console.error("Error subiendo archivo:", error);
      res
        .status(500)
        .json({ message: "❌ Error al subir la app", error: error.message });
    }
  }
);

// 📋 Obtener todas las apps
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

// 🧑‍💻 Verificar si existe admin
app.get("/check-admin", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (result.rows.length > 0)
      res.json({ message: "✅ Ya existe un usuario admin." });
    else res.json({ message: "❌ No hay ningún usuario admin en la base de datos." });
  } catch (error) {
    console.error("❌ Error al consultar la base de datos:", error);
    res.status(500).json({ message: "Error al consultar la base de datos." });
  }
});

// 🧑‍💼 Crear admin si no existe
import bcrypt from "bcrypt";
app.get("/create-admin", async (req, res) => {
  try {
    const adminUser = await db.query("SELECT * FROM users WHERE role = 'admin'");
    if (adminUser.rows.length > 0)
      return res.json({ message: "✅ Ya existe un usuario admin." });

    const hashedPassword = await bcrypt.hash("admin123", 10);
    await db.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin')",
      ["admin", hashedPassword]
    );
    res.json({ message: "✅ Usuario admin creado (usuario: admin / contraseña: admin123)" });
  } catch (error) {
    console.error("❌ Error al crear admin:", error);
    res.status(500).json({ message: "Error al crear admin" });
  }
});

// 🌐 Página principal (index)
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// 🚀 Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
