/* ============================================================================
   SETAPUR BACKEND - FULL POSTGRES VERSION
   - Users, Donations, Expenses, Categories, Gallery/Ebooks metadata, Notifications: ALL in Postgres
   - File uploads: Cloudinary (donations) + local FS (gallery/ebooks)
   - AI, Analytics, Admin/User roles: Fully integrated
============================================================================ */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

app.use((req, res, next) => {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// ========== Static uploads (local FS for gallery/ebooks) ==========
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const galleryDir = path.join(uploadsDir, 'gallery');
if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });

const ebooksDir = path.join(uploadsDir, 'ebooks');
if (!fs.existsSync(ebooksDir)) fs.mkdirSync(ebooksDir, { recursive: true });

/* ===================== POSTGRES CONNECTION ===================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false },
});

/* ===================== DATABASE MIGRATIONS (AUTO-SETUP) ===================== */
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      full_name TEXT,
      display_name TEXT,
      logged_in TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      id SERIAL PRIMARY KEY,
      donor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      donor_username TEXT,
      donor_name TEXT,
      amount NUMERIC NOT NULL,
      payment_method TEXT NOT NULL,
      category TEXT NOT NULL,
      cash_receiver_name TEXT,
      screenshot_url TEXT,
      screenshot_path TEXT,
      receipt_code TEXT UNIQUE,
      approved BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'pending',
      submitted_by TEXT,
      submitted_by_id INTEGER,
      approved_by TEXT,
      approved_by_id INTEGER,
      approved_by_role TEXT,
      approved_by_name TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      paid_to TEXT,
      date TIMESTAMPTZ,
      enabled BOOLEAN DEFAULT TRUE,
      approved BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'pending',
      submitted_by TEXT,
      submitted_by_id INTEGER,
      approved_by TEXT,
      approved_by_id INTEGER,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_folders (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      cover_file TEXT,
      icon_file TEXT,
      icon_key TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      folder_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_images (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES gallery_folders(slug) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      image_order INTEGER DEFAULT 0,
      size BIGINT,
      uploaded_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(folder_slug, filename)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ebook_folders (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ebook_files (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES ebook_folders(slug) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      file_order INTEGER DEFAULT 0,
      size BIGINT,
      uploaded_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(folder_slug, filename)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      data JSONB,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_folders (
      id SERIAL PRIMARY KEY,
      folder_id TEXT UNIQUE NOT NULL,
      folder_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      folder_id TEXT REFERENCES analytics_folders(folder_id) ON DELETE CASCADE,
      event_id TEXT UNIQUE NOT NULL,
      event_name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      show_donation_detail BOOLEAN DEFAULT TRUE,
      show_expense_detail BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  console.log('✅ Database tables ensured');
}

/* ===================== CLOUDINARY SETUP (Donation Screenshots) ===================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const donationScreenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'setapur/screenshots', allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'], resource_type: 'image' },
});
const uploadDonationScreenshot = multer({ storage: donationScreenshotStorage, limits: { fileSize: 20 * 1024 * 1024 } });

/* ===================== LOCAL MULTER (Gallery & Ebooks) ===================== */
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const PDF_EXT = new Set(['.pdf']);

// Gallery per-folder upload
const galleryStoragePerFolder = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const slug = String(req.params.slug || '').trim();
      if (!slug) return cb(new Error('slug required'));
      const targetDir = path.join(galleryDir, slug);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  },
});
const uploadGallery = multer({
  storage: galleryStoragePerFolder,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMG_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only image files allowed'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: 25 },
});

// Gallery root upload
const galleryStorageRoot = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });
      cb(null, galleryDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  },
});
const uploadRootGallery = multer({
  storage: galleryStorageRoot,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMG_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only image files allowed'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: 25 },
});

// Ebooks per-folder upload
const ebooksStoragePerFolder = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const slug = String(req.params.slug || '').trim();
      if (!slug) return cb(new Error('slug required'));
      const targetDir = path.join(ebooksDir, slug);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  },
});
const uploadEbooksFolder = multer({
  storage: ebooksStoragePerFolder,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (PDF_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024, files: 25 },
});

// Ebooks root upload
const ebooksStorageRoot = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!fs.existsSync(ebooksDir)) fs.mkdirSync(ebooksDir, { recursive: true });
      cb(null, ebooksDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  },
});
const uploadEbooksRoot = multer({
  storage: ebooksStorageRoot,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (PDF_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024, files: 25 },
});

/* ===================== JWT & AUTH ===================== */
const SECRET_KEY = process.env.JWT_SECRET || 'your_secret_key_here';

function normRole(r) {
  return String(r || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function authRole(roles) {
  const allowed = (Array.isArray(roles) ? roles : [roles]).map(normRole);
  return async (req, res, next) => {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).send('Access Denied');
    try {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
      const verified = jwt.verify(token, SECRET_KEY);
      verified.role = normRole(verified.role);
      verified.username = String(verified.username || '');
      req.user = verified;

      if (!allowed.includes(req.user.role) && !allowed.includes('any')) {
        return res.status(403).send('Forbidden');
      }

      // Check banned
      const { rows } = await pool.query(`SELECT banned FROM users WHERE username=$1`, [req.user.username]);
      if (rows[0] && rows[0].banned) return res.status(403).send('User banned');

      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).send('Token expired');
      return res.status(400).send('Invalid Token');
    }
  };
}

/* ===================== SEED ADMIN ===================== */
async function seedAdmin() {
  try {
    const username = process.env.INIT_ADMIN_USERNAME || 'admin';
    const password = process.env.INIT_ADMIN_PASSWORD || 'Admin@123';
    const role = 'mainadmin';
    const { rows } = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
    if (rows.length === 0) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO users (username, password_hash, role, banned) VALUES ($1,$2,$3,$4)`,
        [username, hash, role, false]
      );
      console.log(`Seeded admin user '${username}'`);
    } else {
      console.log(`Admin user '${username}' already exists`);
    }
  } catch (e) {
    console.warn('Admin seed skipped:', e.message);
  }
}

/* ===================== HELPERS ===================== */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function isApproved(d) {
  return d && (d.approved === true || d.approved === 'true' || d.approved === 1 || d.approved === '1');
}

const SENSITIVE_KEYS = [
  'screenshot_url', 'screenshot_path', 'payment_screenshot', 'screenshot',
  'cash_receiver_name', 'receiver_name', 'received_by',
];

function redactDonationForRole(d, role) {
  const out = { ...d };
  if (isApproved(out) && role !== 'mainadmin') {
    SENSITIVE_KEYS.forEach((k) => { if (k in out) delete out[k]; });
  }
  return out;
}

async function pushNotification(username, notif) {
  try {
    await pool.query(
      `INSERT INTO notifications (username, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [username, notif.type, notif.title, notif.body, JSON.stringify(notif.data || {})]
    );
  } catch (_) {}
}

/* ===================== RECEIPT CODE GENERATION (6-char alphanumeric) ===================== */
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = ALPHA + DIGITS;

function randomChar(pool) {
  return pool[crypto.randomInt(0, pool.length)];
}

function generate6CharAlnumMix() {
  const arr = [randomChar(ALPHA), randomChar(DIGITS)];
  for (let i = 0; i < 4; i++) arr.push(randomChar(ALNUM));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

async function generateUniqueReceiptCode() {
  const { rows } = await pool.query(`SELECT receipt_code FROM donations`);
  const used = new Set(rows.map(r => String(r.receipt_code || '').toUpperCase()));
  let code;
  let tries = 0;
  do {
    code = generate6CharAlnumMix();
    tries++;
  } while (used.has(code) && tries < 1000);
  return code;
}

/* ===================== AUTH: LOGIN ===================== */
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body || {};
    const { rows } = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
    if (!rows.length) return res.status(400).send('User not found');
    const user = rows[0];
    if (user.banned) return res.status(403).send('User banned');
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).send('Invalid password');

    await pool.query(`UPDATE users SET logged_in=$1 WHERE id=$2`, [deviceId, user.id]);

    const cleanRole = normRole(user.role || 'user');
    const token = jwt.sign({ id: user.id, username: user.username, role: cleanRole }, SECRET_KEY, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).send('Login failed');
  }
});

/* ===================== ADMIN: CREATE/LIST USERS ===================== */
const ALLOWED_ROLES = new Set(['user', 'admin', 'mainadmin']);

app.post('/admin/users', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const usernameIn = (req.body?.username || req.body?.id || '').toString().trim();
    const passwordIn = (req.body?.password || '').toString();
    let roleIn = (req.body?.role || 'user').toString().trim().toLowerCase();
    if (!ALLOWED_ROLES.has(roleIn)) roleIn = 'user';
    if (!usernameIn || !passwordIn) return res.status(400).json({ error: 'username and password required' });

    const { rows: existing } = await pool.query(`SELECT * FROM users WHERE username=$1`, [usernameIn]);
    if (existing.length) return res.status(409).json({ error: 'username already exists' });

    const hash = await bcrypt.hash(passwordIn, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role, banned) VALUES ($1,$2,$3,$4) RETURNING id, username, role`,
      [usernameIn, hash, roleIn, false]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('create user error:', e);
    res.status(500).json({ error: 'Create user failed' });
  }
});

app.get('/admin/users', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, username, role, banned FROM users ORDER BY id ASC`);
    res.json(rows);
  } catch (e) {
    console.error('list users error:', e);
    res.status(500).send('Failed to list users');
  }
});

/* ===================== DONATIONS (with Cloudinary screenshot) ===================== */
app.post('/api/donations/submit-donation', authRole(['user', 'admin', 'mainadmin']), uploadDonationScreenshot.single('screenshot'), async (req, res) => {
  try {
    const { amount, paymentMethod, category, cashReceiverName, donorName } = req.body;
    if (!donorName || !String(donorName).trim()) return res.status(400).json({ error: 'donorName is required' });
    if (!amount || !paymentMethod || !category) return res.status(400).json({ error: 'amount, paymentMethod, and category are required' });

    const code = await generateUniqueReceiptCode();
    const screenshotUrl = req.file?.path || null;
    const screenshotPath = req.file?.filename || null;

    const donorUsername = req.user.username;
    const donorUserId = req.user.id;
    const donorDisplayName = (donorName && String(donorName).trim()) || donorUsername;

    const { rows } = await pool.query(
      `INSERT INTO donations (donor_user_id, donor_username, donor_name, amount, payment_method, category, cash_receiver_name, screenshot_url, screenshot_path, receipt_code, approved, status, submitted_by, submitted_by_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now()) RETURNING *`,
      [donorUserId, donorUsername, donorDisplayName, Number(amount), paymentMethod, category, cashReceiverName || null, screenshotUrl, screenshotPath, code, false, 'pending', donorUsername, donorUserId]
    );

    return res.status(201).json({ message: 'Donation submitted', donation: rows[0] });
  } catch (err) {
    console.error('submit-donation error:', err);
    return res.status(500).send('Failed to submit donation');
  }
});

app.post('/api/donations/create', authRole(['user', 'admin', 'mainadmin']), uploadDonationScreenshot.single('screenshot'), async (req, res) => {
  try {
    const { amount, paymentMethod, category, cashReceiverName, donorName } = req.body;
    if (!donorName || !String(donorName).trim()) return res.status(400).json({ error: 'donorName is required' });
    if (!amount || !paymentMethod || !category) return res.status(400).json({ error: 'amount, paymentMethod, and category are required' });

    const code = await generateUniqueReceiptCode();
    const screenshotUrl = req.file?.path || null;
    const screenshotPath = req.file?.filename || null;

    const donorUsername = req.user.username;
    const donorUserId = req.user.id;
    const donorDisplayName = (donorName && String(donorName).trim()) || donorUsername;

    const { rows } = await pool.query(
      `INSERT INTO donations (donor_user_id, donor_username, donor_name, amount, payment_method, category, cash_receiver_name, screenshot_url, screenshot_path, receipt_code, approved, status, submitted_by, submitted_by_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now()) RETURNING *`,
      [donorUserId, donorUsername, donorDisplayName, Number(amount), paymentMethod, category, cashReceiverName || null, screenshotUrl, screenshotPath, code, false, 'pending', donorUsername, donorUserId]
    );

    return res.status(201).json({ message: 'Donation created', donation: rows[0] });
  } catch (err) {
    console.error('create donation error:', err);
    return res.status(500).send('Failed to create donation');
  }
});

app.get('/myaccount/receipts', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const username = req.user.username;
    const { rows } = await pool.query(
      `SELECT * FROM donations WHERE donor_username=$1 AND approved=true ORDER BY created_at DESC`,
      [username]
    );
    res.json(rows);
  } catch (e) {
    console.error('receipts error:', e);
    res.status(500).send('Failed to fetch receipts');
  }
});

app.get('/api/donations/donations', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const status = String(req.query.status || 'approved').toLowerCase();
    const role = req.user.role;
    const q = (req.query.q || req.query.search || '').toString().trim().toLowerCase();

    let query = `SELECT * FROM donations`;
    let params = [];

    if ((role === 'admin' || role === 'mainadmin') && status === 'all') {
      // Admin sees all
    } else if (status === 'pending') {
      query += ` WHERE donor_username=$1 AND approved=false`;
      params.push(req.user.username);
    } else if (status === 'approved') {
      query += ` WHERE donor_username=$1 AND approved=true`;
      params.push(req.user.username);
    } else {
      query += ` WHERE donor_username=$1`;
      params.push(req.user.username);
    }

    query += ` ORDER BY created_at DESC`;
    const { rows } = await pool.query(query, params);

    let list = rows;
    if (q) {
      list = list.filter(d => {
        const name = String(d.donor_name || d.donor_username || '').toLowerCase();
        const rc = String(d.receipt_code || '').toLowerCase();
        const cat = String(d.category || '').toLowerCase();
        return name.includes(q) || rc.includes(q) || cat.includes(q);
      });
    }

    const out = list.map((d) => redactDonationForRole(d, role));
    return res.json(out);
  } catch (e) {
    console.error('donations list error:', e);
    res.status(500).send('Failed to list donations');
  }
});

app.get('/api/donations/all-donations', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const role = req.user.role;
    const q = (req.query.q || req.query.search || '').toString().trim().toLowerCase();

    const { rows } = await pool.query(`SELECT * FROM donations ORDER BY created_at DESC`);

    let list = rows;
    if (q) {
      list = list.filter(d => {
        const name = String(d.donor_name || d.donor_username || '').toLowerCase();
        const rc = String(d.receipt_code || '').toLowerCase();
        const cat = String(d.category || '').toLowerCase();
        return name.includes(q) || rc.includes(q) || cat.includes(q);
      });
    }

    const out = list.map((d) => redactDonationForRole(d, role));
    res.json(out);
  } catch (e) {
    console.error('all donations error:', e);
    res.status(500).send('Failed to list donations');
  }
});

app.get('/api/donations/search', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.q || req.query.search || '').toString().trim().toLowerCase();
    if (!q) return res.json([]);

    let query = `SELECT * FROM donations`;
    let params = [];

    if (!isAdmin) {
      query += ` WHERE (approved=true OR donor_username=$1)`;
      params.push(req.user.username);
    }

    query += ` ORDER BY created_at DESC LIMIT 100`;
    const { rows } = await pool.query(query, params);

    let list = rows.filter(d => {
      const name = String(d.donor_name || d.donor_username || '').toLowerCase();
      const rc = String(d.receipt_code || '').toLowerCase();
      const cat = String(d.category || '').toLowerCase();
      return name.includes(q) || rc.includes(q) || cat.includes(q);
    });

    const out = list.map(d => redactDonationForRole(d, role));
    res.json(out);
  } catch (e) {
    console.error('donation search error:', e);
    res.status(500).send('Search failed');
  }
});

app.get('/admin/donations/pending', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM donations WHERE approved=false ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    console.error('pending donations error:', e);
    res.status(500).send('Failed to list pending donations');
  }
});

app.post('/admin/donations/:id/approve', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: donations } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    if (!donations.length) return res.status(404).json({ error: 'Donation not found' });

    const d = donations[0];
    const alreadyApproved = isApproved(d);

    let approvedByName = req.user.username;
    const { rows: users } = await pool.query(`SELECT name, full_name, display_name FROM users WHERE username=$1`, [req.user.username]);
    if (users.length) {
      approvedByName = users[0].name || users[0].full_name || users[0].display_name || req.user.username;
    }

    const rc = String(d.receipt_code || '').toUpperCase();
    const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
    const newCode = valid ? rc : await generateUniqueReceiptCode();

    await pool.query(
      `UPDATE donations SET approved=true, status='approved', approved_by=$1, approved_by_id=$2, approved_by_role=$3, approved_by_name=$4, approved_at=now(), receipt_code=$5, updated_at=now() WHERE id=$6`,
      [req.user.username, req.user.id, req.user.role, approvedByName, newCode, id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    const donation = updated[0];

    if (!alreadyApproved) {
      const donorUser = d.donor_username || d.donor_name || null;
      if (donorUser) {
        await pushNotification(donorUser, {
          type: 'donationApproval',
          title: 'Donation approved',
          body: `Receipt: ${newCode} • Event: ${d.category} • Amount: ₹${Number(d.amount || 0)}`,
          data: { receiptCode: newCode, category: d.category, amount: d.amount, paymentMethod: d.payment_method, approved: true },
        });
      }
    }

    return res.json({ message: 'Donation approved', donation });
  } catch (err) {
    console.error('admin approve error:', err);
    return res.status(500).send('Approval failed');
  }
});

app.post('/admin/donations/:id/disapprove', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });

    await pool.query(
      `UPDATE donations SET approved=false, status='pending', approved_by=NULL, approved_by_id=NULL, approved_by_role=NULL, approved_by_name=NULL, approved_at=NULL, updated_at=now() WHERE id=$1`,
      [id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    return res.json({ message: 'Donation set to pending', donation: updated[0] });
  } catch (err) {
    console.error('admin disapprove error:', err);
    return res.status(500).send('Disapprove failed');
  }
});

app.put('/admin/donations/:id', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const { rows } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });

    const d = rows[0];

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      d.amount = amt;
    }
    if (typeof body.donorName === 'string') d.donor_name = body.donorName.trim();
    if (typeof body.category === 'string') d.category = body.category.trim();
    if (typeof body.paymentMethod === 'string') d.payment_method = body.paymentMethod.trim();
    if (typeof body.cashReceiverName === 'string') d.cash_receiver_name = body.cashReceiverName.trim();

    if (typeof body.receiptCode === 'string' && body.receiptCode.trim()) {
      const rc = body.receiptCode.trim().toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      const { rows: dup } = await pool.query(`SELECT * FROM donations WHERE receipt_code=$1 AND id!=$2`, [rc, id]);
      if (!valid) return res.status(400).json({ error: 'receiptCode must be 6-char A-Z0-9 with at least 1 letter & 1 digit' });
      if (dup.length) return res.status(409).json({ error: 'receiptCode already exists' });
      d.receipt_code = rc;
    }
    if (body.regenerateReceiptCode === true || body.regenerateReceiptCode === 'true') {
      d.receipt_code = await generateUniqueReceiptCode();
    }

    await pool.query(
      `UPDATE donations SET amount=$1, donor_name=$2, category=$3, payment_method=$4, cash_receiver_name=$5, receipt_code=$6, updated_at=now() WHERE id=$7`,
      [d.amount, d.donor_name, d.category, d.payment_method, d.cash_receiver_name, d.receipt_code, id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    return res.json({ message: 'Donation updated', donation: updated[0] });
  } catch (e) {
    console.error('update donation error:', e);
    res.status(500).send('Update donation failed');
  }
});

app.put('/api/donations/:id', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const { rows } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });

    const d = rows[0];

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      d.amount = amt;
    }
    if (typeof body.donorName === 'string') d.donor_name = body.donorName.trim();
    if (typeof body.category === 'string') d.category = body.category.trim();
    if (typeof body.paymentMethod === 'string') d.payment_method = body.paymentMethod.trim();
    if (typeof body.cashReceiverName === 'string') d.cash_receiver_name = body.cashReceiverName.trim();

    if (typeof body.receiptCode === 'string' && body.receiptCode.trim()) {
      const rc = body.receiptCode.trim().toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      const { rows: dup } = await pool.query(`SELECT * FROM donations WHERE receipt_code=$1 AND id!=$2`, [rc, id]);
      if (!valid) return res.status(400).json({ error: 'receiptCode must be 6-char A-Z0-9 with at least 1 letter & 1 digit' });
      if (dup.length) return res.status(409).json({ error: 'receiptCode already exists' });
      d.receipt_code = rc;
    }
    if (body.regenerateReceiptCode === true || body.regenerateReceiptCode === 'true') {
      d.receipt_code = await generateUniqueReceiptCode();
    }

    await pool.query(
      `UPDATE donations SET amount=$1, donor_name=$2, category=$3, payment_method=$4, cash_receiver_name=$5, receipt_code=$6, updated_at=now() WHERE id=$7`,
      [d.amount, d.donor_name, d.category, d.payment_method, d.cash_receiver_name, d.receipt_code, id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    return res.json({ message: 'Donation updated', donation: updated[0] });
  } catch (e) {
    console.error('update donation error:', e);
    res.status(500).send('Update donation failed');
  }
});

app.post('/api/donations/approve', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id, approve } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const { rows } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    const d = rows[0];

    const wantApprove = (approve === true || approve === 'true' || approve === 1 || approve === '1');

    if (wantApprove) {
      const alreadyApproved = isApproved(d);

      let approvedByName = req.user.username;
      const { rows: users } = await pool.query(`SELECT name, full_name, display_name FROM users WHERE username=$1`, [req.user.username]);
      if (users.length) {
        approvedByName = users[0].name || users[0].full_name || users[0].display_name || req.user.username;
      }

      const rc = String(d.receipt_code || '').toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      const newCode = valid ? rc : await generateUniqueReceiptCode();

      await pool.query(
        `UPDATE donations SET approved=true, status='approved', approved_by=$1, approved_by_id=$2, approved_by_role=$3, approved_by_name=$4, approved_at=now(), receipt_code=$5, updated_at=now() WHERE id=$6`,
        [req.user.username, req.user.id, req.user.role, approvedByName, newCode, id]
      );

      const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
      const donation = updated[0];

      if (!alreadyApproved) {
        const donorUser = d.donor_username || d.donor_name || null;
        if (donorUser) {
          await pushNotification(donorUser, {
            type: 'donationApproval',
            title: 'Donation approved',
            body: `Receipt: ${newCode} • Event: ${d.category} • Amount: ₹${Number(d.amount || 0)}`,
            data: { receiptCode: newCode, category: d.category, amount: d.amount, paymentMethod: d.payment_method, approved: true },
          });
        }
      }

      return res.json({ message: 'Donation approved', donation });
    } else {
      await pool.query(
        `UPDATE donations SET approved=false, status='pending', approved_by=NULL, approved_by_id=NULL, approved_by_role=NULL, approved_by_name=NULL, approved_at=NULL, updated_at=now() WHERE id=$1`,
        [id]
      );

      const { rows: updated } = await pool.query(`SELECT * FROM donations WHERE id=$1`, [id]);
      return res.json({ message: 'Donation set to pending', donation: updated[0] });
    }
  } catch (e) {
    console.error('alias /api/donations/approve error:', e);
    res.status(500).send('Operation failed');
  }
});

/* ===================== EXPENSES (DB) ===================== */
app.get('/api/expenses/list', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.category || req.query.eventName || req.query.eventId || '').toString().trim().toLowerCase();
    const statusQ = (req.query.status || (isAdmin ? 'all' : 'approved')).toString().toLowerCase();
    const includeDisabledQ = (req.query.includeDisabled || '').toString().toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const includePendingMineQ = (req.query.includePendingMine || req.query.mine || '').toString().toLowerCase();
    const includePendingMine = includePendingMineQ === '1' || includePendingMineQ === 'true';

    let query = `SELECT * FROM expenses`;
    let params = [];
    let conditions = [];

    if (q) {
      conditions.push(`LOWER(category)=$${params.length + 1}`);
      params.push(q);
    }

    if (isAdmin) {
      if (statusQ === 'approved') {
        conditions.push(`approved=true`);
      } else if (statusQ === 'pending') {
        conditions.push(`approved=false`);
      }
      if (!includeDisabled) {
        conditions.push(`enabled=true`);
      }
    } else {
      // User: approved+enabled OR mine pending
      if (includePendingMine && req.user && req.user.username) {
        conditions.push(`((approved=true AND enabled=true) OR (submitted_by=$${params.length + 1} AND approved=false))`);
        params.push(req.user.username);
      } else {
        conditions.push(`approved=true AND enabled=true`);
      }
    }

    if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
    query += ` ORDER BY date DESC, created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error('list expenses error:', e);
    res.status(500).send('Failed to list expenses');
  }
});

app.post('/api/expenses/submit', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const { amount, category, eventName, description, paidTo, date } = req.body || {};
    const cat = (category || eventName || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category (event) is required' });
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });

    const now = new Date();
    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, paid_to, date, enabled, approved, status, submitted_by, submitted_by_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now()) RETURNING *`,
      [amt, cat, (description || '').toString().trim(), (paidTo || '').toString().trim(), date ? new Date(date) : now, true, false, 'pending', req.user?.username || null, req.user?.id || null]
    );

    const e = rows[0];

    if (e.submitted_by) {
      await pushNotification(e.submitted_by, {
        type: 'expenseSubmit',
        title: 'Expense submitted',
        body: `${e.category} • ₹${e.amount} (pending approval)`,
        data: { id: e.id, category: e.category, amount: e.amount, approved: false },
      });
    }

    res.status(201).json({ message: 'Expense submitted (pending)', expense: e });
  } catch (err) {
    console.error('submit expense error:', err);
    res.status(500).send('Submit expense failed');
  }
});

app.post('/api/expenses', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { amount, category, description, paidTo, date, approveNow } = req.body || {};
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
    const cat = (category || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category is required' });

    const approve = approveNow !== false && approveNow !== 'false';
    const now = new Date();

    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, paid_to, date, enabled, approved, status, submitted_by, submitted_by_id, approved_by, approved_by_id, approved_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()) RETURNING *`,
      [amt, cat, (description || '').toString().trim(), (paidTo || '').toString().trim(), date ? new Date(date) : now, true, approve, approve ? 'approved' : 'pending', req.user?.username || null, req.user?.id || null, approve ? req.user.username : null, approve ? req.user.id : null, approve ? now : null]
    );

    res.status(201).json({ message: 'Expense created', expense: rows[0] });
  } catch (err) {
    console.error('create expense error:', err);
    res.status(500).send('Create expense failed');
  }
});

app.put('/api/expenses/:id', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });

    const e = rows[0];
    const body = req.body || {};

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      e.amount = amt;
    }
    if (typeof body.category === 'string') e.category = body.category.trim();
    if (typeof body.description === 'string') e.description = body.description.trim();
    if (typeof body.paidTo === 'string') e.paid_to = body.paidTo.trim();
    if (body.date) e.date = new Date(body.date);
    if (body.enabled !== undefined) e.enabled = body.enabled !== false && body.enabled !== 'false';

    await pool.query(
      `UPDATE expenses SET amount=$1, category=$2, description=$3, paid_to=$4, date=$5, enabled=$6, updated_at=now() WHERE id=$7`,
      [e.amount, e.category, e.description, e.paid_to, e.date, e.enabled, id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    res.json({ message: 'Expense updated', expense: updated[0] });
  } catch (err) {
    console.error('update expense error:', err);
    res.status(500).send('Update expense failed');
  }
});

app.post('/api/expenses/:id/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });

    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';

    await pool.query(`UPDATE expenses SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, id]);

    const { rows: updated } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    res.json({ ok: true, expense: updated[0] });
  } catch (e) {
    console.error('enable expense error:', e);
    res.status(500).send('Failed to enable/disable expense');
  }
});

app.post('/admin/expenses/:id/approve', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });

    const approveRaw = req.body.approve;
    const approve = approveRaw === true || approveRaw === 'true' || approveRaw === 1 || approveRaw === '1';

    await pool.query(
      `UPDATE expenses SET approved=$1, status=$2, approved_by=$3, approved_by_id=$4, approved_at=now(), updated_at=now() WHERE id=$5`,
      [approve, approve ? 'approved' : 'pending', req.user.username, req.user.id, id]
    );

    const { rows: updated } = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    const e = updated[0];

    const who = e.submitted_by || null;
    if (who) {
      await pushNotification(who, {
        type: `expense${approve ? 'Approval' : 'Pending'}`,
        title: `Expense ${approve ? 'approved' : 'set to pending'}`,
        body: `${e.category} • ₹${e.amount}`,
        data: { id: e.id, category: e.category, approved: approve },
      });
    }

    res.json({ message: `Expense ${approve ? 'approved' : 'set to pending'}`, expense: e });
  } catch (e) {
    console.error('approve expense error:', e);
    res.status(500).send('Approval failed');
  }
});

app.delete('/api/expenses/:id', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`DELETE FROM expenses WHERE id=$1 RETURNING *`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted', expense: rows[0] });
  } catch (err) {
    console.error('delete expense error:', err);
    res.status(500).send('Delete expense failed');
  }
});

/* ===================== ANALYTICS SUMMARY (DB-driven) ===================== */
app.get('/analytics/summary', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const { rows: folders } = await pool.query(`SELECT * FROM analytics_folders ORDER BY id ASC`);
    const { rows: events } = await pool.query(`SELECT * FROM analytics_events ORDER BY id ASC`);
    const { rows: donations } = await pool.query(`SELECT * FROM donations WHERE approved=true`);
    const { rows: expenses } = await pool.query(`SELECT * FROM expenses WHERE approved=true AND enabled=true`);

    const out = [];

    for (const folder of folders) {
      const folderEvents = events.filter(e => e.folder_id === folder.folder_id);
      const eventsMap = {};

      for (const ev of folderEvents) {
        const evName = ev.event_name || '';
        const showDonationDetail = ev.show_donation_detail !== false;
        const showExpenseDetail = ev.show_expense_detail !== false;

        const dList = donations.filter(d => String(d.category || '').toLowerCase().trim() === evName.toLowerCase().trim());
        const donationTotal = dList.reduce((s, d) => s + Number(d.amount || 0), 0);

        const eList = expenses.filter(e => String(e.category || '').toLowerCase().trim() === evName.toLowerCase().trim());
        const expenseTotal = eList.reduce((s, e) => s + Number(e.amount || 0), 0);

        const donationsSlim = dList.map(d => ({
          id: d.id,
          donorName: d.donor_name || d.donor_username || '',
          amount: Number(d.amount || 0),
          paymentMethod: d.payment_method || '',
          category: d.category || '',
          createdAt: d.created_at || null,
          receiptCode: d.receipt_code || null,
        }));

        eventsMap[evName] = {
          donationTotal,
          expenseTotal,
          balance: donationTotal - expenseTotal,
          donations: donationsSlim,
          config: {
            showDonationDetail,
            showExpenseDetail,
            enabled: ev.enabled !== false,
          },
        };
      }

      out.push({
        folderName: folder.folder_name || '',
        folderId: folder.folder_id || '',
        events: eventsMap,
      });
    }

    return res.json(out);
  } catch (e) {
    console.error('analytics summary error:', e);
    res.status(500).send('Analytics summary failed');
  }
});

/* ===================== TOTALS (FALLBACK) ===================== */
app.get('/totals', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const { rows: donations } = await pool.query(`SELECT * FROM donations WHERE approved=true`);
    const totalDonation = donations.reduce((sum, d) => sum + Number(d.amount || 0), 0);

    const { rows: expenses } = await pool.query(`SELECT * FROM expenses WHERE approved=true AND enabled=true`);
    const totalExpense = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const balance = totalDonation - totalExpense;
    res.json({ totalDonation, totalExpense, balance });
  } catch (e) {
    console.error('totals error:', e);
    res.status(500).send('Totals failed');
  }
});

/* ===================== GALLERY (Metadata in DB, Files in FS) ===================== */
// List folders
app.get('/gallery/folders', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const showDisabled = isAdmin || includeDisabled;

    let query = `SELECT * FROM gallery_folders ORDER BY folder_order ASC, name ASC`;
    if (!showDisabled) query = `SELECT * FROM gallery_folders WHERE enabled=true ORDER BY folder_order ASC, name ASC`;

    const { rows } = await pool.query(query);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const foldersOut = rows.map(f => ({
      name: f.name,
      slug: f.slug,
      url: `${host}/uploads/gallery/${f.slug}/`,
      cover: f.cover_file,
      coverUrl: f.cover_file ? `${host}/uploads/gallery/${f.slug}/${encodeURIComponent(f.cover_file)}` : null,
      iconFile: f.icon_file,
      iconUrl: f.icon_file ? `${host}/uploads/gallery/${f.slug}/${encodeURIComponent(f.icon_file)}` : null,
      iconKey: f.icon_key || null,
      enabled: f.enabled !== false,
      order: f.folder_order || 0,
    }));

    res.json(foldersOut);
  } catch (e) {
    console.error('gallery list error:', e);
    res.status(500).send('Failed to list gallery folders');
  }
});

// List images in folder
app.get('/gallery/folders/:slug/images', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    let query = `SELECT * FROM gallery_images WHERE folder_slug=$1 ORDER BY image_order ASC, filename ASC`;
    if (!showDisabled) query = `SELECT * FROM gallery_images WHERE folder_slug=$1 AND enabled=true ORDER BY image_order ASC, filename ASC`;

    const { rows } = await pool.query(query, [slug]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const list = rows.map(img => ({
      name: img.filename,
      url: `${host}/uploads/gallery/${slug}/${encodeURIComponent(img.filename)}`,
      size: img.size,
      modifiedAt: img.uploaded_at,
      enabled: img.enabled !== false,
    }));

    res.json(list);
  } catch (e) {
    console.error('gallery images error:', e);
    res.status(500).send('Failed to list images');
  }
});

// Root images
app.get('/gallery/images', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabled === '1' || includeDisabled === 'true';

    let query = `SELECT * FROM gallery_images WHERE folder_slug IS NULL ORDER BY image_order ASC, filename ASC`;
    if (!showDisabled) query = `SELECT * FROM gallery_images WHERE folder_slug IS NULL AND enabled=true ORDER BY image_order ASC, filename ASC`;

    const { rows } = await pool.query(query);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const list = rows.map(img => ({
      name: img.filename,
      url: `${host}/uploads/gallery/${encodeURIComponent(img.filename)}`,
      size: img.size,
      modifiedAt: img.uploaded_at,
      enabled: img.enabled !== false,
      order: img.image_order || 0,
    }));

    res.json(list);
  } catch (e) {
    console.error('gallery root images error:', e);
    res.status(500).send('Failed to list gallery images');
  }
});

app.get('/gallery/home/images', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabled === '1' || includeDisabled === 'true';

    let query = `SELECT * FROM gallery_images WHERE folder_slug IS NULL ORDER BY image_order ASC, filename ASC`;
    if (!showDisabled) query = `SELECT * FROM gallery_images WHERE folder_slug IS NULL AND enabled=true ORDER BY image_order ASC, filename ASC`;

    const { rows } = await pool.query(query);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const list = rows.map(img => ({
      name: img.filename,
      url: `${host}/uploads/gallery/${encodeURIComponent(img.filename)}`,
      size: img.size,
      modifiedAt: img.uploaded_at,
      enabled: img.enabled !== false,
      order: img.image_order || 0,
    }));

    res.json(list);
  } catch (e) {
    console.error('gallery root images error:', e);
    res.status(500).send('Failed to list gallery images');
  }
});

// Upload to folder
app.post('/gallery/folders/:slug/upload', authRole(['admin', 'mainadmin']), uploadGallery.array('images', 25), async (req, res) => {
  try {
    const { slug } = req.params;
    const files = req.files || [];
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const uploaded = [];

    for (const f of files) {
      const { rows } = await pool.query(
        `INSERT INTO gallery_images (folder_slug, filename, enabled, image_order, size, uploaded_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING *`,
        [slug, f.filename, true, 0, f.size]
      );
      uploaded.push({
        name: f.filename,
        size: f.size,
        url: `${host}/uploads/gallery/${encodeURIComponent(slug)}/${encodeURIComponent(f.filename)}`,
      });
    }

    return res.status(201).json({ uploaded, count: uploaded.length });
  } catch (e) {
    console.error('gallery upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Upload to root
app.post('/gallery/upload', authRole(['admin', 'mainadmin']), uploadRootGallery.array('images', 25), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

    const uploaded = [];
    for (const f of files) {
      await pool.query(
        `INSERT INTO gallery_images (folder_slug, filename, enabled, image_order, size, uploaded_at) VALUES (NULL,$1,$2,$3,$4,now())`,
        [f.filename, true, 0, f.size]
      );
      uploaded.push({
        name: f.filename,
        url: `${host}/uploads/gallery/${encodeURIComponent(f.filename)}`,
        size: f.size,
      });
    }

    res.status(201).json({ uploaded, count: uploaded.length });
  } catch (e) {
    console.error('root upload error:', e);
    res.status(500).send('Upload failed');
  }
});

app.post('/gallery/home/upload', authRole(['admin', 'mainadmin']), uploadRootGallery.array('images', 25), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

    const uploaded = [];
    for (const f of files) {
      await pool.query(
        `INSERT INTO gallery_images (folder_slug, filename, enabled, image_order, size, uploaded_at) VALUES (NULL,$1,$2,$3,$4,now())`,
        [f.filename, true, 0, f.size]
      );
      uploaded.push({
        name: f.filename,
        url: `${host}/uploads/gallery/${encodeURIComponent(f.filename)}`,
        size: f.size,
      });
    }

    res.status(201).json({ uploaded, count: uploaded.length });
  } catch (e) {
    console.error('root upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Create folder
app.post('/gallery/folders/create', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    if (!slug) return res.status(400).json({ error: 'invalid name' });

    const { rows: existing } = await pool.query(`SELECT * FROM gallery_folders WHERE slug=$1`, [slug]);
    if (existing.length) return res.status(409).json({ error: 'folder already exists', slug });

    const dir = path.join(galleryDir, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await pool.query(
      `INSERT INTO gallery_folders (slug, name, enabled, folder_order) VALUES ($1,$2,$3,$4)`,
      [slug, String(name).trim(), true, 0]
    );

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return res.status(201).json({ name: String(name).trim(), slug, url: `${host}/uploads/gallery/${slug}/` });
  } catch (e) {
    console.error('gallery create error:', e);
    res.status(500).send('Failed to create folder');
  }
});

// Set cover
app.post('/gallery/folders/:slug/cover', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (!filename || !String(filename).trim()) return res.status(400).json({ error: 'filename is required' });

    const folderPath = path.join(galleryDir, slug);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });

    const target = path.resolve(path.join(folderPath, filename));
    const safeRoot = path.resolve(folderPath);
    if (!target.startsWith(safeRoot) || !fs.existsSync(target)) return res.status(404).json({ error: 'file not found in folder' });

    await pool.query(`UPDATE gallery_folders SET cover_file=$1 WHERE slug=$2`, [filename, slug]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const coverUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(filename)}`;
    res.json({ ok: true, slug, cover: filename, coverUrl });
  } catch (e) {
    console.error('set cover error:', e);
    res.status(500).send('Failed to set cover');
  }
});

// Set icon
const ALLOWED_ICON_KEYS = new Set([
  'temple', 'event', 'flower', 'music', 'book', 'home', 'star', 'people', 'calendar', 'camera', 'donation', 'festival'
]);

app.post('/gallery/folders/:slug/icon', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, iconKey, clear } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const folderPath = path.join(galleryDir, slug);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });

    if (clear === true || clear === 'true' || clear === 1 || clear === '1') {
      await pool.query(`UPDATE gallery_folders SET icon_file=NULL, icon_key=NULL WHERE slug=$1`, [slug]);
      return res.json({ ok: true, slug, iconFile: null, iconKey: null, iconUrl: null });
    }

    if (filename && String(filename).trim()) {
      const fn = String(filename).trim();
      const target = path.resolve(path.join(folderPath, fn));
      const safeRoot = path.resolve(folderPath);
      if (!target.startsWith(safeRoot) || !fs.existsSync(target)) return res.status(404).json({ error: 'file not found in folder' });
      const ext = path.extname(fn).toLowerCase();
      if (!IMG_EXT.has(ext)) return res.status(400).json({ error: 'Invalid image extension' });

      await pool.query(`UPDATE gallery_folders SET icon_file=$1, icon_key=NULL WHERE slug=$2`, [fn, slug]);

      const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const iconUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(fn)}`;
      return res.json({ ok: true, slug, iconFile: fn, iconKey: null, iconUrl });
    }

    if (iconKey && String(iconKey).trim()) {
      const key = String(iconKey).trim();
      if (!ALLOWED_ICON_KEYS.has(key)) return res.status(400).json({ error: 'Invalid iconKey', allowed: Array.from(ALLOWED_ICON_KEYS) });

      await pool.query(`UPDATE gallery_folders SET icon_key=$1, icon_file=NULL WHERE slug=$2`, [key, slug]);
      return res.json({ ok: true, slug, iconFile: null, iconKey: key, iconUrl: null });
    }

    return res.status(400).json({ error: 'Provide filename OR iconKey OR clear=true' });
  } catch (e) {
    console.error('set icon error:', e);
    res.status(500).send('Failed to set icon');
  }
});

// Enable/disable folder
app.post('/gallery/folders/:slug/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';

    await pool.query(`UPDATE gallery_folders SET enabled=$1 WHERE slug=$2`, [enabled, slug]);
    res.json({ ok: true, slug, enabled });
  } catch (e) {
    console.error('enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

// Reorder folders
app.post('/gallery/folders/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug, direction, newIndex } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Simple reorder logic: set folder_order to newIndex if provided
    if (typeof newIndex === 'number') {
      await pool.query(`UPDATE gallery_folders SET folder_order=$1 WHERE slug=$2`, [newIndex, slug]);
    }

    const { rows } = await pool.query(`SELECT slug, folder_order FROM gallery_folders ORDER BY folder_order ASC`);
    res.json({ ok: true, folderOrder: rows.map(r => r.slug) });
  } catch (e) {
    console.error('reorder folders error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});

app.post('/gallery/folders/:slug/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { direction, newIndex } = req.body || {};

    if (typeof newIndex === 'number') {
      await pool.query(`UPDATE gallery_folders SET folder_order=$1 WHERE slug=$2`, [newIndex, slug]);
    }

    const { rows } = await pool.query(`SELECT slug, folder_order FROM gallery_folders ORDER BY folder_order ASC`);
    res.json({ ok: true, folderOrder: rows.map(r => r.slug) });
  } catch (e) {
    console.error('reorder folders (param) error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});

// Rename folder
app.post('/gallery/folders/:slug/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    let { name, newName } = req.body || {};
    const desired = String((name || newName || '')).trim();
    if (!desired) return res.status(400).json({ error: 'name (or newName) required' });
    const newSlug = slugify(desired);
    if (!newSlug) return res.status(400).json({ error: 'invalid newName' });

    const src = path.join(galleryDir, slug);
    const dest = path.join(galleryDir, newSlug);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'folder not found' });
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', slug: newSlug });

    fs.renameSync(src, dest);

    await pool.query(`UPDATE gallery_folders SET slug=$1, name=$2 WHERE slug=$3`, [newSlug, desired, slug]);
    await pool.query(`UPDATE gallery_images SET folder_slug=$1 WHERE folder_slug=$2`, [newSlug, slug]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, slug: newSlug, name: desired, url: `${host}/uploads/gallery/${newSlug}/` });
  } catch (e) {
    console.error('rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

// Delete folder
app.delete('/gallery/folders/:slug', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const dir = path.join(galleryDir, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' });

    fs.rmSync(dir, { recursive: true, force: true });
    await pool.query(`DELETE FROM gallery_folders WHERE slug=$1`, [slug]);

    res.json({ ok: true, slug });
  } catch (e) {
    console.error('delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

// Reorder images inside folder
app.post('/gallery/folders/:slug/images/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, direction, newIndex } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });

    if (typeof newIndex === 'number') {
      await pool.query(`UPDATE gallery_images SET image_order=$1 WHERE folder_slug=$2 AND filename=$3`, [newIndex, slug, filename]);
    }

    const { rows } = await pool.query(`SELECT filename FROM gallery_images WHERE folder_slug=$1 ORDER BY image_order ASC`, [slug]);
    res.json({ ok: true, imageOrder: rows.map(r => r.filename) });
  } catch (e) {
    console.error('reorder images error:', e);
    res.status(500).send('Failed to reorder images');
  }
});

// Enable/disable image inside folder
app.post('/gallery/folders/:slug/images/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    if (!filename) return res.status(400).json({ error: 'filename required' });

    await pool.query(`UPDATE gallery_images SET enabled=$1 WHERE folder_slug=$2 AND filename=$3`, [enabled, slug, filename]);

    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('enable image error:', e);
    res.status(500).send('Failed to update image enabled');
  }
});

// Rename image inside folder
app.post('/gallery/folders/:slug/images/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, newName } = req.body || {};
    if (!filename || !newName) return res.status(400).json({ error: 'filename and newName required' });

    const folderPath = path.join(galleryDir, slug);
    const src = path.join(folderPath, filename);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'file not found' });

    const ext = path.extname(filename).toLowerCase();
    const baseNew = slugify(String(newName).replace(path.extname(newName), ''));
    const targetName = baseNew + ext;
    const dest = path.join(folderPath, targetName);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', filename: targetName });

    fs.renameSync(src, dest);

    await pool.query(`UPDATE gallery_images SET filename=$1 WHERE folder_slug=$2 AND filename=$3`, [targetName, slug, filename]);
    await pool.query(`UPDATE gallery_folders SET cover_file=$1 WHERE slug=$2 AND cover_file=$3`, [targetName, slug, filename]);
    await pool.query(`UPDATE gallery_folders SET icon_file=$1 WHERE slug=$2 AND icon_file=$3`, [targetName, slug, filename]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/gallery/${slug}/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('rename image error:', e);
    res.status(500).send('Failed to rename image');
  }
});

// Delete image inside folder
app.delete('/gallery/folders/:slug/images', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const p = path.join(galleryDir, slug, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });

    fs.unlinkSync(p);
    await pool.query(`DELETE FROM gallery_images WHERE folder_slug=$1 AND filename=$2`, [slug, filename]);
    await pool.query(`UPDATE gallery_folders SET cover_file=NULL WHERE slug=$1 AND cover_file=$2`, [slug, filename]);
    await pool.query(`UPDATE gallery_folders SET icon_file=NULL WHERE slug=$1 AND icon_file=$2`, [slug, filename]);

    res.json({ ok: true, filename });
  } catch (e) {
    console.error('delete image error:', e);
    res.status(500).send('Failed to delete file');
  }
});

/* ===================== EBOOKS (similar structure) ===================== */
// List folders
app.get('/ebooks/folders', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    let query = `SELECT * FROM ebook_folders ORDER BY name ASC`;
    if (!showDisabled) query = `SELECT * FROM ebook_folders WHERE enabled=true ORDER BY name ASC`;

    const { rows } = await pool.query(query);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const folders = [];

    for (const f of rows) {
      const { rows: files } = await pool.query(`SELECT COUNT(*) as count FROM ebook_files WHERE folder_slug=$1`, [f.slug]);
      folders.push({
        name: f.name,
        slug: f.slug,
        url: `${host}/uploads/ebooks/${f.slug}/`,
        fileCount: files[0].count || 0,
        enabled: f.enabled !== false,
      });
    }

    res.json(folders);
  } catch (e) {
    console.error('ebooks folders error:', e);
    res.status(500).send('Failed to list e-book folders');
  }
});

// List root PDFs
app.get('/ebooks/files', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    let query = `SELECT * FROM ebook_files WHERE folder_slug IS NULL ORDER BY file_order ASC, filename ASC`;
    if (!showDisabled) query = `SELECT * FROM ebook_files WHERE folder_slug IS NULL AND enabled=true ORDER BY file_order ASC, filename ASC`;

    const { rows } = await pool.query(query);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const files = rows.map(f => ({
      name: f.filename,
      url: `${host}/uploads/ebooks/${encodeURIComponent(f.filename)}`,
      size: f.size,
      modifiedAt: f.uploaded_at,
      enabled: f.enabled !== false,
      order: f.file_order || 0,
    }));

    res.json(files);
  } catch (e) {
    console.error('ebooks root files error:', e);
    res.status(500).send('Failed to list e-books');
  }
});

// List PDFs inside a folder
app.get('/ebooks/folders/:slug/files', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    let query = `SELECT * FROM ebook_files WHERE folder_slug=$1 ORDER BY file_order ASC, filename ASC`;
    if (!showDisabled) query = `SELECT * FROM ebook_files WHERE folder_slug=$1 AND enabled=true ORDER BY file_order ASC, filename ASC`;

    const { rows } = await pool.query(query, [slug]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const files = rows.map(f => ({
      name: f.filename,
      url: `${host}/uploads/ebooks/${encodeURIComponent(slug)}/${encodeURIComponent(f.filename)}`,
      size: f.size,
      modifiedAt: f.uploaded_at,
      enabled: f.enabled !== false,
    }));

    res.json(files);
  } catch (e) {
    console.error('ebooks folder files error:', e);
    res.status(500).send('Failed to list e-books in folder');
  }
});

// Create folder
app.post('/ebooks/folders/create', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    if (!slug) return res.status(400).json({ error: 'invalid name' });

    const { rows: existing } = await pool.query(`SELECT * FROM ebook_folders WHERE slug=$1`, [slug]);
    if (existing.length) return res.status(409).json({ error: 'folder already exists', slug });

    const dir = path.join(ebooksDir, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await pool.query(`INSERT INTO ebook_folders (slug, name, enabled) VALUES ($1,$2,$3)`, [slug, String(name).trim(), true]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({ name: String(name).trim(), slug, url: `${host}/uploads/ebooks/${slug}/` });
  } catch (e) {
    console.error('ebooks create folder error:', e);
    res.status(500).send('Failed to create folder');
  }
});

// Rename folder
app.post('/ebooks/folders/:slug/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, newName } = req.body || {};
    const desired = String((name || newName || '')).trim();
    if (!desired) return res.status(400).json({ error: 'name (or newName) required' });
    const newSlug = slugify(desired);

    const src = path.join(ebooksDir, slug);
    const dest = path.join(ebooksDir, newSlug);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'folder not found' });
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', slug: newSlug });

    fs.renameSync(src, dest);

    await pool.query(`UPDATE ebook_folders SET slug=$1, name=$2 WHERE slug=$3`, [newSlug, desired, slug]);
    await pool.query(`UPDATE ebook_files SET folder_slug=$1 WHERE folder_slug=$2`, [newSlug, slug]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, slug: newSlug, name: desired, url: `${host}/uploads/ebooks/${newSlug}/` });
  } catch (e) {
    console.error('ebooks rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

// Enable/disable folder
app.post('/ebooks/folders/:slug/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');

    await pool.query(`UPDATE ebook_folders SET enabled=$1 WHERE slug=$2`, [enabled, slug]);
    res.json({ ok: true, slug, enabled });
  } catch (e) {
    console.error('ebooks enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

// Delete folder
app.delete('/ebooks/folders/:slug', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const dir = path.join(ebooksDir, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' });

    fs.rmSync(dir, { recursive: true, force: true });
    await pool.query(`DELETE FROM ebook_folders WHERE slug=$1`, [slug]);

    res.json({ ok: true, slug });
  } catch (e) {
    console.error('ebooks delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

// Upload PDFs to root
app.post('/ebooks/upload', authRole(['admin', 'mainadmin']), uploadEbooksRoot.array('files', 25), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const out = [];

    for (const f of files) {
      await pool.query(
        `INSERT INTO ebook_files (folder_slug, filename, enabled, file_order, size, uploaded_at) VALUES (NULL,$1,$2,$3,$4,now())`,
        [f.filename, true, 0, f.size]
      );
      out.push({ name: f.filename, size: f.size, url: `${host}/uploads/ebooks/${encodeURIComponent(f.filename)}` });
    }

    res.status(201).json({ uploaded: out, count: out.length });
  } catch (e) {
    console.error('ebooks root upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Upload PDFs to a folder
app.post('/ebooks/folders/:slug/upload', authRole(['admin', 'mainadmin']), uploadEbooksFolder.array('files', 25), async (req, res) => {
  try {
    const { slug } = req.params;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const out = [];

    for (const f of files) {
      await pool.query(
        `INSERT INTO ebook_files (folder_slug, filename, enabled, file_order, size, uploaded_at) VALUES ($1,$2,$3,$4,$5,now())`,
        [slug, f.filename, true, 0, f.size]
      );
      out.push({ name: f.filename, size: f.size, url: `${host}/uploads/ebooks/${encodeURIComponent(slug)}/${encodeURIComponent(f.filename)}` });
    }

    res.status(201).json({ uploaded: out, count: out.length, folder: slug });
  } catch (e) {
    console.error('ebooks folder upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Root file rename
app.post('/ebooks/files/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { filename, newName } = req.body || {};
    if (!filename || !newName) return res.status(400).json({ error: 'filename and newName required' });
    const src = path.join(ebooksDir, filename);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'file not found' });

    const ext = path.extname(filename).toLowerCase();
    const baseNew = slugify(String(newName).replace(path.extname(newName), ''));
    const targetName = baseNew + ext;
    const dest = path.join(ebooksDir, targetName);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', filename: targetName });

    fs.renameSync(src, dest);
    await pool.query(`UPDATE ebook_files SET filename=$1 WHERE folder_slug IS NULL AND filename=$2`, [targetName, filename]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/ebooks/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('ebooks root rename error:', e);
    res.status(500).send('Failed to rename file');
  }
});

// Root file enable/disable
app.post('/ebooks/files/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    if (!filename) return res.status(400).json({ error: 'filename required' });

    await pool.query(`UPDATE ebook_files SET enabled=$1 WHERE folder_slug IS NULL AND filename=$2`, [enabled, filename]);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('ebooks root enable error:', e);
    res.status(500).send('Failed to update file enabled');
  }
});

// Root file delete
app.delete('/ebooks/files', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const p = path.join(ebooksDir, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });

    fs.unlinkSync(p);
    await pool.query(`DELETE FROM ebook_files WHERE folder_slug IS NULL AND filename=$1`, [filename]);

    res.json({ ok: true, filename });
  } catch (e) {
    console.error('ebooks root delete error:', e);
    res.status(500).send('Failed to delete file');
  }
});

// Folder file rename
app.post('/ebooks/folders/:slug/files/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, newName } = req.body || {};
    if (!filename || !newName) return res.status(400).json({ error: 'filename and newName required' });

    const folderPath = path.join(ebooksDir, slug);
    const src = path.join(folderPath, filename);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'file not found' });

    const ext = path.extname(filename).toLowerCase();
    const baseNew = slugify(String(newName).replace(path.extname(newName), ''));
    const targetName = baseNew + ext;
    const dest = path.join(folderPath, targetName);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', filename: targetName });

    fs.renameSync(src, dest);
    await pool.query(`UPDATE ebook_files SET filename=$1 WHERE folder_slug=$2 AND filename=$3`, [targetName, slug, filename]);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/ebooks/${slug}/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('ebooks rename file error:', e);
    res.status(500).send('Failed to rename file');
  }
});

// Folder file enable/disable
app.post('/ebooks/folders/:slug/files/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    if (!filename) return res.status(400).json({ error: 'filename required' });

    await pool.query(`UPDATE ebook_files SET enabled=$1 WHERE folder_slug=$2 AND filename=$3`, [enabled, slug, filename]);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('ebooks enable file error:', e);
    res.status(500).send('Failed to update file enabled');
  }
});

// Folder file delete
app.delete('/ebooks/folders/:slug/files', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { slug } = req.params;
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const p = path.join(ebooksDir, slug, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });

    fs.unlinkSync(p);
    await pool.query(`DELETE FROM ebook_files WHERE folder_slug=$1 AND filename=$2`, [slug, filename]);

    res.json({ ok: true, filename });
  } catch (e) {
    console.error('ebooks delete file error:', e);
    res.status(500).send('Failed to delete file');
  }
});

/* ===================== DEBUG & HEALTH ===================== */
app.get('/debug/donations', async (req, res) => {
  try {
    const { rows: all } = await pool.query(`SELECT * FROM donations`);
    const { rows: approved } = await pool.query(`SELECT * FROM donations WHERE approved=true`);
    res.json({
      allCount: all.length,
      approvedCount: approved.length,
      approvedSample: approved.slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});

app.get('/debug/expenses', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM expenses`);
    res.json({ count: rows.length, sample: rows.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});

app.get('/debug/events', async (req, res) => {
  try {
    const { rows: folders } = await pool.query(`SELECT * FROM analytics_folders`);
    const { rows: events } = await pool.query(`SELECT * FROM analytics_events`);
    res.json({ folders, events });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});

app.get('/admin/whoami', authRole(['admin', 'mainadmin']), (req, res) => {
  res.json(req.user);
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ===================== START SERVER ===================== */
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

async function start() {
  try {
    await setupDatabase();
    await seedAdmin();
    app.listen(PORT, HOST, () => {
      console.log(`✅ Server listening on http://${HOST}:${PORT}`);
    });
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
}

start();
