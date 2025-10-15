import dotenv from "dotenv";
dotenv.config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const stripeLib = require('stripe');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || null,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// init stripe
const stripe = stripeLib(process.env.STRIPE_SECRET_KEY || '');

// init s3
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_KEY,
    secretAccessKey: process.env.AWS_SECRET
  }
});
const S3_BUCKET = process.env.S3_BUCKET;

// multer - memory for direct upload to S3
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB limit

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session store using Postgres (connect-pg-simple)
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// --- DB initialisation: create tables if missing ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apps (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      imagen TEXT,
      archivo TEXT NOT NULL,
      price_cents INTEGER DEFAULT 199,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDb().catch(err => console.error('DB init error', err));

// Create initial admin user if provided via env (only if no users)
async function createInitialAdmin() {
  try {
    const res = await pool.query('SELECT COUNT(*) FROM users');
    if (res.rows[0].count === '0' && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
      await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [process.env.ADMIN_USER, hash]);
      console.log('Initial admin user created:', process.env.ADMIN_USER);
    }
  } catch (err) {
    console.error('createInitialAdmin err', err);
  }
}
createInitialAdmin();

// --- Helpers ---
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts('html')) return res.redirect('/login.html');
  return res.status(401).json({ error: 'No autorizado' });
}

async function uploadBufferToS3(buffer, key, contentType) {
  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read'
  });
  await s3.send(cmd);
  return `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// --- Public API ---
// list apps
app.get('/api/apps', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, nombre, descripcion, imagen, archivo, price_cents, created_at FROM apps ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// detail
app.get('/api/apps/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// create checkout session (returns Stripe URL)
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { appId } = req.body;
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
    if (!rows[0]) return res.status(404).json({ error: 'App no encontrada' });

    const appData = rows[0];
    const price = appData.price_cents || 199; // cents

    // create Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: appData.nombre, description: appData.descripcion },
          unit_amount: price
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: { appId: String(appId) },
      success_url: `${PUBLIC_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/cancel.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session err', err);
    res.status(500).json({ error: 'Stripe error' });
  }
});

// webhook to confirm payment and optionally issue a signed download link (recommended)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = req.body;
    }
  } catch (err) {
    console.error('Webhook signature error', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const appId = session.metadata ? session.metadata.appId : null;
    const customerEmail = session.customer_details ? session.customer_details.email : null;

    // you can save payment record to DB if you want
    try {
      await pool.query('INSERT INTO payments (session_id, app_id, customer_email, paid_at) VALUES ($1, $2, $3, NOW())', [session.id, appId, customerEmail]);
    } catch (err) {
      // create payments table if not exists (one-time)
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          session_id TEXT,
          app_id INTEGER,
          customer_email TEXT,
          paid_at TIMESTAMP
        );`);
        await pool.query('INSERT INTO payments (session_id, app_id, customer_email, paid_at) VALUES ($1, $2, $3, NOW())', [session.id, appId, customerEmail]);
      } catch (e) {
        console.error('payments table error', e);
      }
    }
  }

  res.json({ received: true });
});

// --- ADMIN AUTH ---
// create user (only via API; once created you can disable this route)
app.post('/api/admin/create-user', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not create user' });
  }
});

// login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });
    req.session.user = { id: user.id, username: user.username };
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error' });
  }
});

// logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// check session
app.get('/api/admin/session', (req, res) => {
  if (req.session && req.session.user) return res.json({ logged: true, user: req.session.user });
  res.json({ logged: false });
});

// --- ADMIN: upload apps (memory -> s3 -> DB) ---
app.post('/api/admin/upload', requireLogin, upload.fields([{ name: 'archivo', maxCount: 1 }, { name: 'imagen', maxCount: 1 }]), async (req, res) => {
  try {
    const nombre = req.body.nombre || 'Sin nombre';
    const descripcion = req.body.descripcion || '';
    const price_cents = parseInt(req.body.price_cents || '199', 10);

    if (!req.files || !req.files['archivo'] || !req.files['archivo'][0]) {
      return res.status(400).json({ error: 'archivo is required' });
    }

    const archivoFile = req.files['archivo'][0];
    const archivoKey = `apps/${Date.now()}_${archivoFile.originalname.replace(/\s+/g, '_')}`;
    const archivoUrl = await uploadBufferToS3(archivoFile.buffer, archivoKey, archivoFile.mimetype);

    let imagenUrl = null;
    if (req.files['imagen'] && req.files['imagen'][0]) {
      const imgFile = req.files['imagen'][0];
      const imgKey = `img/${Date.now()}_${imgFile.originalname.replace(/\s+/g, '_')}`;
      imagenUrl = await uploadBufferToS3(imgFile.buffer, imgKey, imgFile.mimetype);
    }

    const result = await pool.query('INSERT INTO apps (nombre, descripcion, imagen, archivo, price_cents) VALUES ($1,$2,$3,$4,$5) RETURNING *', [nombre, descripcion, imagenUrl, archivoUrl, price_cents]);
    res.json({ success: true, app: result.rows[0] });
  } catch (err) {
    console.error('upload err', err);
    res.status(500).json({ error: 'Error uploading' });
  }
});

// Admin: list apps
app.get('/api/admin/apps', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, nombre, descripcion, imagen, archivo, price_cents, created_at FROM apps ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: update app
app.put('/api/admin/apps/:id', requireLogin, async (req, res) => {
  try {
    const { nombre, descripcion, price_cents } = req.body;
    await pool.query('UPDATE apps SET nombre=$1, descripcion=$2, price_cents=$3 WHERE id=$4', [nombre, descripcion, price_cents || 199, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: delete app (and optionally delete S3 objects — not implemented here to avoid accidental deletes)
app.delete('/api/admin/apps/:id', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT archivo, imagen FROM apps WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    // optionally delete S3 objects here using DeleteObjectCommand if desired
    await pool.query('DELETE FROM apps WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Generate temporary signed URL for download (only if you want to protect downloads)
app.get('/api/apps/:id/download', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT archivo FROM apps WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    const archivoUrl = rows[0].archivo;

    // If archivoUrl is an S3 public URL we can return it; if we want signed URL we assume it's an S3 key
    // Here we try to parse the S3 key from the stored URL:
    // expected format: https://BUCKET.s3.REGION.amazonaws.com/key
    const s3prefix = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;
    if (archivoUrl.startsWith(s3prefix)) {
      const key = archivoUrl.replace(s3prefix, '');
      const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
      const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 }); // 5 minutes
      return res.json({ url: signed });
    }

    // fallback
    res.json({ url: archivoUrl });
  } catch (err) {
    console.error('download err', err);
    res.status(500).json({ error: 'Error generating link' });
  }
});

// Fallback: serve index for SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// import bcrypt from "bcrypt";
import db from "./db.js"; // o el nombre de tu archivo de conexión con la DB

app.get("/create-admin", async (req, res) => {
  try {
    // revisa si ya existe
    const check = await db.query("SELECT * FROM users WHERE username = $1", ["admin"]);
    if (check.rows.length > 0) {
      return res.send("✅ Ya existe un usuario admin.");
    }

    // crea hash de la contraseña
    const hash = await bcrypt.hash("123456", 10);

    // inserta el nuevo admin
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


// Start
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



