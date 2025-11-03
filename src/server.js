/* === SETAPUR BACKEND - COMPLETE WORKING CODE === */
/* Just copy-paste this entire file as src/server.js */

require('dotenv').config();

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

// VALIDATION
const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('FATAL: Missing env vars:', missingEnvVars.join(', '));
  process.exit(1);
}

// DATABASE
const useSSL = !!(process.env.DATABASE_URL && /sslmode=require|neon|render|amazonaws|neon.tech/i.test(process.env.DATABASE_URL)) || process.env.PGSSL === '1';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});
pool.on('error', (err) => console.error('DB Error:', err));

// CLOUDINARY
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// JWT
const SECRET_KEY = process.env.JWT_SECRET;
if (!SECRET_KEY) { console.error('FATAL: JWT_SECRET not set'); process.exit(1); }

// PORT
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// EXPRESS
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => { console.log(req.method, req.path); next(); });

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// HELPERS
function normRole(r) { return String(r || '').trim().toLowerCase().replace(/[\s_-]+/g, ''); }

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
      if (!allowed.includes(req.user.role) && !allowed.includes('any')) return res.status(403).send('Forbidden');
      try {
        const users = await getUsers();
        const u = users.find(u => String(u.username) === req.user.username);
        if (u && (u.banned === true || u.banned === 'true')) return res.status(403).send('Banned');
      } catch (e) {}
      next();
    } catch (err) {
      return res.status(400).send('Invalid Token');
    }
  };
}

// USERS TABLE
async function ensureUsersTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    banned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
}

function rowToUser(r) {
  return { id: r.id, username: r.username, passwordHash: r.password_hash, role: r.role, banned: r.banned, createdAt: r.created_at };
}

async function getUsers() {
  await ensureUsersTable();
  const { rows } = await pool.query('SELECT id, username, password_hash, role, banned, created_at FROM users ORDER BY id ASC');
  return rows.map(rowToUser);
}

async function saveUsers(users) {
  await ensureUsersTable();
  if (!Array.isArray(users)) return;
  for (const u of users) {
    let passwordHash = u.passwordHash || null;
    if (u.password && String(u.password).trim()) {
      passwordHash = await bcrypt.hash(u.password, 10);
      delete u.password;
    }
    await pool.query(
      `INSERT INTO users (username, password_hash, role, banned) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE SET password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash), role = EXCLUDED.role, banned = EXCLUDED.banned`,
      [u.username, passwordHash, String(u.role || 'user'), !!u.banned]
    );
  }
}

async function seedAdmin() {
  try {
    const users = await getUsers();
    const username = process.env.INIT_ADMIN_USERNAME || 'admin';
    const password = process.env.INIT_ADMIN_PASSWORD || 'Admin@123';
    const idx = users.findIndex(u => String(u.username) === String(username));
    if (idx === -1) {
      const next = users.slice();
      next.push({ username, password, role: 'mainadmin', banned: false });
      await saveUsers(next);
    }
  } catch (e) {
    console.warn('Admin seed failed:', e.message);
  }
}

// AUTH ENDPOINTS
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const users = await getUsers();
    const user = users.find((u) => u.username === username);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'User banned' });
    const validPass = await bcrypt.compare(password, user.passwordHash);
    if (!validPass) return res.status(400).json({ error: 'Invalid password' });
    const cleanRole = normRole(user.role || 'user');
    const token = jwt.sign({ id: user.id, username: user.username, role: cleanRole }, SECRET_KEY, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/admin/users', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    const usernameIn = (req.body?.username || '').toString().trim();
    const passwordIn = (req.body?.password || '').toString();
    let roleIn = (req.body?.role || 'user').toString().trim().toLowerCase();
    if (!usernameIn || !passwordIn) return res.status(400).json({ error: 'username and password required' });
    const users = await getUsers();
    if (users.find(u => String(u.username).toLowerCase() === usernameIn.toLowerCase())) {
      return res.status(409).json({ error: 'username already exists' });
    }
    const next = users.slice();
    next.push({ username: usernameIn, password: passwordIn, role: roleIn, banned: false });
    await saveUsers(next);
    const after = await getUsers();
    const created = after.find(u => String(u.username).toLowerCase() === usernameIn.toLowerCase());
    res.status(201).json({ id: created?.id, username: created?.username, role: created?.role });
  } catch (e) {
    console.error('create user error:', e);
    res.status(500).json({ error: 'Create user failed' });
  }
});

app.get('/admin/users', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    const users = await getUsers();
    res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, banned: !!u.banned })));
  } catch (e) {
    console.error('list users error:', e);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// CATEGORIES
async function ensureCategoriesTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
}

function rowToCategory(r) {
  return { id: r.id, name: r.name, enabled: r.enabled, createdAt: r.created_at };
}

app.get('/api/categories', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureCategoriesTable();
    const { rows } = await pool.query('SELECT id, name, enabled, created_at FROM categories ORDER BY lower(name) ASC');
    res.json(rows.map(rowToCategory));
  } catch (e) {
    res.status(500).send('Failed to list categories');
  }
});

app.post('/api/categories', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureCategoriesTable();
    const nm = (req.body?.name ?? '').toString().trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query('INSERT INTO categories(name, enabled) VALUES ($1, TRUE) ON CONFLICT (name) DO NOTHING RETURNING id, name, enabled, created_at', [nm]);
    if (!rows.length) return res.status(409).json({ error: 'category already exists' });
    res.status(201).json(rowToCategory(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Create failed' });
  }
});

// EXPENSES
async function ensureExpensesTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    amount NUMERIC NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    paid_to TEXT,
    date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    enabled BOOLEAN DEFAULT TRUE,
    approved BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'pending',
    submitted_by TEXT,
    submitted_by_id INT,
    approved_by TEXT,
    approved_by_id INT,
    approved_at TIMESTAMPTZ
  );`);
}

function rowToExpense(r) {
  return {
    id: r.id, amount: Number(r.amount), category: r.category, description: r.description, paidTo: r.paid_to, date: r.date, createdAt: r.created_at,
    updatedAt: r.updated_at, enabled: r.enabled, approved: r.approved, status: r.status, submittedBy: r.submitted_by, submittedById: r.submitted_by_id,
    approvedBy: r.approved_by, approvedById: r.approved_by_id, approvedAt: r.approved_at
  };
}

app.get('/api/expenses/list', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { rows } = await pool.query('SELECT * FROM expenses ORDER BY created_at DESC');
    res.json(rows.map(rowToExpense));
  } catch (e) {
    res.status(500).send('Failed');
  }
});

app.post('/api/expenses', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { amount, category, description, paidTo } = req.body || {};
    if (!amount || !category) return res.status(400).json({ error: 'amount and category required' });
    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, paid_to, created_at, updated_at, enabled, approved, status)
       VALUES ($1,$2,$3,$4,now(),now(),true,false,'pending') RETURNING *`,
      [Number(amount), category, description || '', paidTo || '']
    );
    res.status(201).json({ message: 'Expense created', expense: rowToExpense(rows[0]) });
  } catch (e) {
    res.status(500).send('Failed');
  }
});

// DONATIONS
async function ensureDonationsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS donations (
    id SERIAL PRIMARY KEY,
    donor_user_id INT,
    donor_username TEXT,
    donor_name TEXT,
    amount NUMERIC NOT NULL,
    payment_method TEXT NOT NULL,
    category TEXT NOT NULL,
    cash_receiver_name TEXT,
    approved BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'pending',
    screenshot_public_id TEXT,
    screenshot_url TEXT,
    receipt_code TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    approved_by TEXT,
    approved_by_id INT,
    approved_by_role TEXT,
    approved_by_name TEXT,
    approved_at TIMESTAMPTZ
  );`);
}

function rowToDonation(r) {
  return {
    id: r.id, donorUserId: r.donor_user_id, donorUsername: r.donor_username, donorName: r.donor_name, amount: Number(r.amount),
    paymentMethod: r.payment_method, category: r.category, cashReceiverName: r.cash_receiver_name, approved: r.approved, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, screenshotPath: r.screenshot_public_id, screenshotUrl: r.screenshot_url,
    code: r.receipt_code, receiptCode: r.receipt_code, approvedBy: r.approved_by, approvedById: r.approved_by_id,
    approvedByRole: r.approved_by_role, approvedByName: r.approved_by_name, approvedAt: r.approved_at
  };
}

function generate6CharAlnumMix() {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  const ALNUM = ALPHA + DIGITS;
  const arr = [ALPHA[crypto.randomInt(0, ALPHA.length)], DIGITS[crypto.randomInt(0, DIGITS.length)]];
  for (let i = 0; i < 4; i++) arr.push(ALNUM[crypto.randomInt(0, ALNUM.length)]);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

const donationScreenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'setapur/screenshots', allowed_formats: ['jpg','jpeg','png','webp','gif'] },
});
const uploadDonation = multer({ storage: donationScreenshotStorage, limits: { fileSize: 20 * 1024 * 1024 } });

app.post('/api/donations/submit-donation', authRole(['user','admin','mainadmin']), uploadDonation.single('screenshot'), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { amount, paymentMethod, category, cashReceiverName, donorName } = req.body || {};
    if (!donorName || !amount || !paymentMethod || !category) return res.status(400).json({ error: 'missing fields' });
    const code = generate6CharAlnumMix();
    const { rows } = await pool.query(
      `INSERT INTO donations (donor_user_id, donor_username, donor_name, amount, payment_method, category, cash_receiver_name,
        approved, status, created_at, updated_at, screenshot_public_id, screenshot_url, receipt_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,'pending',now(),now(),$8,$9,$10) RETURNING *`,
      [req.user?.id || null, req.user?.username || null, String(donorName).trim(), Number(amount), paymentMethod, category,
       cashReceiverName || null, req.file?.filename || null, req.file?.path || null, code]
    );
    res.status(201).json({ message: 'Donation submitted', donation: rowToDonation(rows[0]) });
  } catch (e) {
    res.status(500).send('Failed');
  }
});

app.get('/api/donations/donations', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { rows } = await pool.query('SELECT * FROM donations ORDER BY created_at DESC');
    res.json(rows.map(rowToDonation));
  } catch (e) {
    res.status(500).send('Failed');
  }
});

app.post('/admin/donations/:id/approve', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { id } = req.params;
    const code = generate6CharAlnumMix();
    const { rows } = await pool.query(
      `UPDATE donations SET approved=true, status='approved', approved_by=$1, approved_by_id=$2, approved_by_role=$3, approved_at=now(),
       receipt_code=$4, updated_at=now() WHERE id=$5 RETURNING *`,
      [req.user.username, req.user.id, req.user.role, code, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    res.json({ message: 'Donation approved', donation: rowToDonation(rows[0]) });
  } catch (e) {
    res.status(500).send('Failed');
  }
});

// GALLERY
async function ensureGalleryTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS gallery_folders (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    order_index INT DEFAULT 0,
    cover_public_id TEXT,
    cover_url TEXT,
    icon_public_id TEXT,
    icon_key TEXT
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS gallery_images (
    id SERIAL PRIMARY KEY,
    folder_slug TEXT REFERENCES gallery_folders(slug) ON DELETE CASCADE,
    public_id TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    order_index INT DEFAULT 0
  );`);
}

app.get('/gallery/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { rows } = await pool.query('SELECT slug, name, enabled, order_index, cover_url, icon_key FROM gallery_folders ORDER BY order_index ASC');
    res.json(rows.map(r => ({ name: r.name, slug: r.slug, coverUrl: r.cover_url || null, iconKey: r.icon_key || null, enabled: r.enabled, order: r.order_index })));
  } catch (e) {
    res.status(500).send('Failed');
  }
});

// EBOOKS
async function ensureEbooksTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ebook_folders (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ebook_files (
    id SERIAL PRIMARY KEY,
    folder_slug TEXT REFERENCES ebook_folders(slug) ON DELETE CASCADE,
    public_id TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE
  );`);
}

app.get('/ebooks/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { rows } = await pool.query('SELECT slug, name, enabled FROM ebook_folders ORDER BY lower(name) ASC');
    res.json(rows.map(r => ({ name: r.name, slug: r.slug, enabled: r.enabled })));
  } catch (e) {
    res.status(500).send('Failed');
  }
});

// DEBUG
app.get('/debug/version', (req, res) => {
  try {
    const txt = fs.readFileSync(__filename, 'utf8');
    const hash = crypto.createHash('sha1').update(txt).digest('hex');
    res.json({ file: __filename, lines: txt.split('\n').length, sha1: hash, ts: Date.now(), node: process.version, port: PORT });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// STARTUP
async function start() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('SETAPUR BACKEND SERVER STARTING');
    console.log('='.repeat(80) + '\n');
    await ensureUsersTable();
    await seedAdmin();
    app.listen(PORT, HOST, () => {
      console.log('\nServer listening on http://' + HOST + ':' + PORT + '\n');
      console.log('='.repeat(80));
    });
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  pool.end(() => { console.log('Database closed'); process.exit(0); });
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  pool.end(() => { console.log('Database closed'); process.exit(0); });
});

start();
