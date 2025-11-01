/* --- server.js (Option B with fixes: Postgres + Cloudinary; alias handler fixes + ALTERs) --- */
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

// Request log
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

// Dev helper: allow ?token=...
app.use((req, res, next) => {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// Static (compat; Cloudinary is primary now)
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

/* ===================== Postgres ===================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false },
});



/* === ANALYTICS_ADMIN_GLOBAL_HELPERS === */
var ensureAnalyticsConfigTables = global.ensureAnalyticsConfigTables || (async function () {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      folder_id INT REFERENCES analytics_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      show_donation_detail BOOLEAN DEFAULT TRUE,
      show_expense_detail BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name));
    CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index);
  `);
});
global.ensureAnalyticsConfigTables = ensureAnalyticsConfigTables;

var reorderAnalyticsFolders = global.reorderAnalyticsFolders || (async function (folderId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(folderId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx, 1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
  }
  for (let i = 0; i < list.length; i++) {
    await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
});
global.reorderAnalyticsFolders = reorderAnalyticsFolders;

var reorderAnalyticsEvents = global.reorderAnalyticsEvents || (async function (folderId, eventId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(eventId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx, 1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
  }
  for (let i = 0; i < list.length; i++) {
    await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
});
global.reorderAnalyticsEvents = reorderAnalyticsEvents;
/* === END ANALYTICS_ADMIN_GLOBAL_HELPERS === *//* === ANALYTICS_ADMIN_GLOBAL_FIX_v2 === */
var ensureAnalyticsConfigTables = global.ensureAnalyticsConfigTables || (async function() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      folder_id INT REFERENCES analytics_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      show_donation_detail BOOLEAN DEFAULT TRUE,
      show_expense_detail BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name));
    CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index);
  `);
});
global.ensureAnalyticsConfigTables = ensureAnalyticsConfigTables;

var reorderAnalyticsFolders = global.reorderAnalyticsFolders || (async function(folderId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(folderId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
});
global.reorderAnalyticsFolders = reorderAnalyticsFolders;

var reorderAnalyticsEvents = global.reorderAnalyticsEvents || (async function(folderId, eventId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(eventId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
});
global.reorderAnalyticsEvents = reorderAnalyticsEvents;
/* === END ANALYTICS_ADMIN_GLOBAL_FIX_v2 === *//* === ANALYTICS_ADMIN_GLOBAL_FIX (defines globals right after Pool) === */
global.ensureAnalyticsConfigTables = global.ensureAnalyticsConfigTables || (async function() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      folder_id INT REFERENCES analytics_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      show_donation_detail BOOLEAN DEFAULT TRUE,
      show_expense_detail BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name));
    CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index);
  `);
});
// removed dup const ensureAnalyticsConfigTables (using var/global)global.reorderAnalyticsFolders = global.reorderAnalyticsFolders || (async function(folderId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(folderId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
});
// removed dup const reorderAnalyticsFolders (using var/global)global.reorderAnalyticsEvents = global.reorderAnalyticsEvents || (async function(folderId, eventId, direction, newIndex) {
  const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(eventId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
});
// removed dup const reorderAnalyticsEvents (using var/global)/* === END ANALYTICS_ADMIN_GLOBAL_FIX === */function pgNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

/* ===================== Cloudinary ===================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ===================== Auth helpers ===================== */
const SECRET_KEY = process.env.JWT_SECRET || 'your_secret_key_here';
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
        if (u && (u.banned === true || u.banned === 'true' || u.banned === 1 || u.banned === '1')) {
          return res.status(403).send('User banned');
        }
      } catch (_) {}
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).send('Token expired');
      return res.status(400).send('Invalid Token');
    }
  };
}

/* ===================== Common helpers ===================== */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
function pushNotification(_username, _notif) {
  // no-op
}
const SENSITIVE_KEYS = ['screenshotUrl', 'screenshotPath', 'paymentScreenshot', 'screenshot', 'cashReceiverName', 'receiverName', 'receivedBy'];
function isApproved(d) { return d && (d.approved === true || d.approved === 'true' || d.approved === 1 || d.approved === '1'); }
function redactDonationForRole(d, role) {
  const out = { ...d };
  if (isApproved(out) && role !== 'mainadmin') {
    SENSITIVE_KEYS.forEach((k) => { if (k in out) delete out[k]; });
  }
  return out;
}
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = ALPHA + DIGITS;
function randomChar(pool) { return pool[crypto.randomInt(0, pool.length)]; }
function generate6CharAlnumMix() {
  const arr = [randomChar(ALPHA), randomChar(DIGITS)];
  for (let i = 0; i < 4; i++) arr.push(randomChar(ALNUM));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

/* ===================== Users (Postgres) ===================== */
async function ensureUsersTable() {
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
  console.log('DB ready: users table ensured');
}
function rowToUser(r) {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    role: r.role,
    banned: r.banned,
    name: r.name || null,
    fullName: r.full_name || null,
    displayName: r.display_name || null,
    loggedIn: r.logged_in || null,
    createdAt: r.created_at,
  };
}
async function getUsers() {
  await ensureUsersTable();
  const { rows } = await pool.query(`
    SELECT id, username, password_hash, role, banned, name, full_name, display_name, logged_in, created_at
    FROM users ORDER BY id ASC
  `);
  return rows.map(rowToUser);
}
async function saveUsers(users) {
  await ensureUsersTable();
  if (!Array.isArray(users)) return;
  for (const u of users) {
    let passwordHash = u.passwordHash || null;
    if (u.password && String(u.password).trim()) {
      passwordHash = bcrypt.hashSync(u.password, 10);
      delete u.password;
    }
    await pool.query(
      `INSERT INTO users (username, password_hash, role, banned, name, full_name, display_name, logged_in)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         role = EXCLUDED.role,
         banned = EXCLUDED.banned,
         name = EXCLUDED.name,
         full_name = EXCLUDED.full_name,
         display_name = EXCLUDED.display_name,
         logged_in = EXCLUDED.logged_in`,
      [
        u.username,
        passwordHash,
        String(u.role || 'user'),
        !!u.banned,
        u.name || null,
        u.fullName || null,
        u.displayName || null,
        u.loggedIn || null,
      ]
    );
  }
}
async function seedAdmin() {
  try {
    const users = await getUsers();
    const username = process.env.INIT_ADMIN_USERNAME || 'admin';
    const password = process.env.INIT_ADMIN_PASSWORD || 'Admin@123';
    const role = 'mainadmin';

    const resetFlag = String(process.env.INIT_ADMIN_RESET || '').toLowerCase();
    const shouldReset = resetFlag === '1' || resetFlag === 'true';

    const idx = Array.isArray(users) ? users.findIndex(u => String(u.username) === String(username)) : -1;

    if (idx === -1) {
      const next = Array.isArray(users) ? users.slice() : [];
      next.push({ username, password, role, banned: false });
      await saveUsers(next);
      console.log(`Seeded admin user '${username}'`);
    } else if (shouldReset) {
      const next = users.slice();
      next[idx].password = password;
      next[idx].role = role;
      next[idx].banned = false;
      await saveUsers(next);
      console.log(`Reset admin user '${username}'`);
    } else {
      console.log(`Admin user '${username}' already exists; skipping seed`);
    }
  } catch (e) {
    console.warn('Admin seed skipped:', e.message);
  }
}

/* ===================== Auth: Login ===================== */
app.post('/auth/login', async (req, res) => {
  const { username, password, deviceId } = req.body || {};
  const users = await getUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(400).send('User not found');
  if (user.banned) return res.status(403).send('User banned');
  const validPass = await bcrypt.compare(password, user.passwordHash);
  if (!validPass) return res.status(400).send('Invalid password');

  user.loggedIn = deviceId; await saveUsers(users);
  const cleanRole = normRole(user.role || 'user');
  const token = jwt.sign({ id: user.id, username: user.username, role: cleanRole }, SECRET_KEY, { expiresIn: '8h' });
  res.json({ token });
});

/* ===================== Admin: Create/List Users ===================== */
const ALLOWED_ROLES = new Set(['user', 'admin', 'mainadmin']);

app.post('/admin/users', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    const usernameIn = (req.body?.username || req.body?.id || '').toString().trim();
    const passwordIn = (req.body?.password || '').toString();
    let roleIn = (req.body?.role || 'user').toString().trim().toLowerCase();
    if (!ALLOWED_ROLES.has(roleIn)) roleIn = 'user';
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
  const users = await getUsers();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, banned: !!u.banned })));
});

/* ===================== DB Schema Ensures (with ALTERs) ===================== */
async function ensureExpensesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      paid_to TEXT,
      date TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS submitted_by TEXT,
      ADD COLUMN IF NOT EXISTS submitted_by_id INT,
      ADD COLUMN IF NOT EXISTS approved_by TEXT,
      ADD COLUMN IF NOT EXISTS approved_by_id INT,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses (lower(category));
    CREATE INDEX IF NOT EXISTS idx_expenses_approved_enabled ON expenses (approved, enabled);
  `);
  console.log('DB ready: expenses');
}
async function ensureDonationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
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
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS approved_by TEXT,
      ADD COLUMN IF NOT EXISTS approved_by_id INT,
      ADD COLUMN IF NOT EXISTS approved_by_role TEXT,
      ADD COLUMN IF NOT EXISTS approved_by_name TEXT,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_donations_cat ON donations (lower(category));
    CREATE INDEX IF NOT EXISTS idx_donations_approved ON donations (approved);
    CREATE INDEX IF NOT EXISTS idx_donations_created ON donations (created_at);
  `);
  console.log('DB ready: donations');
}
async function ensureGalleryTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_folders (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE
    );
  `);
  await pool.query(`
    ALTER TABLE gallery_folders
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cover_public_id TEXT,
      ADD COLUMN IF NOT EXISTS cover_url TEXT,
      ADD COLUMN IF NOT EXISTS icon_public_id TEXT,
      ADD COLUMN IF NOT EXISTS icon_key TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_images (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES gallery_folders(slug) ON DELETE CASCADE,
      public_id TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL
    );
  `);
  await pool.query(`
    ALTER TABLE gallery_images
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bytes INT,
      ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_gallery_images_folder ON gallery_images (folder_slug);
    CREATE INDEX IF NOT EXISTS idx_gallery_images_enabled ON gallery_images (enabled);
  `);
  console.log('DB ready: gallery');
}
async function ensureEbooksTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ebook_folders (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ebook_files (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES ebook_folders(slug) ON DELETE CASCADE,
      public_id TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL
    );
  `);
  await pool.query(`
    ALTER TABLE ebook_files
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bytes INT,
      ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_ebook_files_folder ON ebook_files (folder_slug);
    CREATE INDEX IF NOT EXISTS idx_ebook_files_enabled ON ebook_files (enabled);
  `);
  console.log('DB ready: ebooks');
}
async function ensureCategoriesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_enabled ON categories (enabled);`);
  console.log('DB ready: categories');
}

/* ===================== Categories (DB) + FE aliases ===================== */
const listCategoriesHandler = async (req, res) => {
  try {
    await ensureCategoriesTable();
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());
    let sql = 'SELECT id, name, enabled, created_at FROM categories';
    if (!isAdmin && !includeDisabled) sql += ' WHERE enabled = true';
    sql += ' ORDER BY lower(name) ASC';
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) { console.error('categories list error:', e); res.status(500).send('Failed to list categories'); }
};
const createCategoryHandler = async (req, res) => {
  try {
    await ensureCategoriesTable();
    const { name, enabled } = req.body || {};
    const nm = String(name || '').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const en = !(enabled === false || enabled === 'false' || enabled === 0 || enabled === '0');
    const { rows } = await pool.query('INSERT INTO categories (name, enabled) VALUES ($1,$2) RETURNING *', [nm, en]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if ((e.code || '').startsWith('23')) return res.status(409).json({ error: 'category already exists' });
    console.error('categories create error:', e); res.status(500).send('Create failed');
  }
};

app.get('/api/categories', authRole(['user','admin','mainadmin']), listCategoriesHandler);
app.post('/api/categories', authRole(['admin','mainadmin']), createCategoryHandler);
// FE aliases
app.get('/api/categories/list', authRole(['user','admin','mainadmin']), listCategoriesHandler);
app.post('/api/admin/categories', authRole(['admin','mainadmin']), createCategoryHandler);

/* ===================== Expenses (Postgres) ===================== */
function rowToExpense(r) {
  return {
    id: r.id,
    amount: Number(r.amount),
    category: r.category,
    description: r.description,
    paidTo: r.paid_to,
    date: r.date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    enabled: r.enabled,
    approved: r.approved,
    status: r.status,
    submittedBy: r.submitted_by,
    submittedById: r.submitted_by_id,
    approvedBy: r.approved_by,
    approvedById: r.approved_by_id,
    approvedAt: r.approved_at
  };
}

app.get('/api/expenses/list', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.category || req.query.eventName || req.query.eventId || '').toString().trim().toLowerCase();
    const statusQ = (req.query.status || (isAdmin ? 'all' : 'approved')).toString().toLowerCase();
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());
    const includePendingMine = ['1','true'].includes(String(req.query.includePendingMine || req.query.mine || '').toLowerCase());

    const values = [];
    let where = [];
    if (q) { values.push(q); where.push('lower(category) = $' + values.length); }

    if (isAdmin) {
      if (statusQ === 'approved') where.push('approved = true');
      else if (statusQ === 'pending') where.push('approved = false');
      if (!includeDisabled) where.push('enabled = true');

      let sql = 'SELECT * FROM expenses';
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY COALESCE(date, created_at) DESC';
      const { rows } = await pool.query(sql, values);
      return res.json(rows.map(rowToExpense));
    } else {
      // approved+enabled
      let sql = `SELECT * FROM expenses WHERE approved = true AND enabled = true`;
      if (where.length) sql += ' AND ' + where.join(' AND ');
      const { rows: approvedEnabled } = await pool.query(sql, values);
      let list = approvedEnabled.map(rowToExpense);

      if (includePendingMine && req.user?.username) {
        const mineVals = values.slice();
        mineVals.push(req.user.username);
        let mineWhere = where.length ? ' AND ' + where.join(' AND ') : '';
        const { rows: mine } = await pool.query(
          `SELECT * FROM expenses WHERE submitted_by = $${mineVals.length} AND approved = false${mineWhere}`, mineVals
        );
        const seen = new Set(list.map(x=>x.id));
        for (const r of mine) { if (!seen.has(r.id)) list.push(rowToExpense(r)); }
      }

      list.sort((a,b)=> new Date(b.date||b.createdAt) - new Date(a.date||a.createdAt));
      return res.json(list);
    }
  } catch (e) {
    console.error('list expenses error:', e);
    res.status(500).send('Failed to list expenses');
  }
});

app.post('/api/expenses/submit', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { amount, category, eventName, description, paidTo, date } = req.body || {};
    const cat = (category || eventName || '').toString().trim();
    const amt = Number(amount);
    if (!cat) return res.status(400).json({ error: 'category (event) is required' });
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
    const now = new Date();
    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, submitted_by, submitted_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$6,true,false,'pending',$7,$8) RETURNING *`,
      [amt, cat, (description||'').trim(), (paidTo||'').trim(), date ? new Date(date) : now, now, req.user?.username || null, req.user?.id || null]
    );
    const e = rowToExpense(rows[0]);
    if (e.submittedBy) {
      pushNotification(e.submittedBy, {
        type: 'expenseSubmit',
        title: 'Expense submitted',
        body: `${e.category} � ?${e.amount} (pending approval)`,
        data: { id: e.id, category: e.category, amount: e.amount, approved: false },
      });
    }
    res.status(201).json({ message: 'Expense submitted (pending)', expense: e });
  } catch (err) {
    console.error('submit expense error:', err);
    res.status(500).send('Submit expense failed');
  }
});

app.post('/api/expenses', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { amount, category, description, paidTo, date, approveNow } = req.body || {};
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
    const cat = (category || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category is required' });

    const approve = !(approveNow === false || approveNow === 'false');
    const now = new Date();
    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, submitted_by, submitted_by_id, approved_by, approved_by_id, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,true,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [amt, cat, (description||'').trim(), (paidTo||'').trim(), date ? new Date(date) : now, now,
       approve, (approve ? 'approved' : 'pending'), req.user?.username || null, req.user?.id || null,
       approve ? req.user?.username : null, approve ? req.user?.id : null, approve ? now : null]
    );
    res.status(201).json({ message: 'Expense created', expense: rowToExpense(rows[0]) });
  } catch (err) {
    console.error('create expense error:', err);
    res.status(500).send('Create expense failed');
  }
});

app.put('/api/expenses/:id', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const body = req.body || {};
    const fields = []; const vals = []; let idx = 1;

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      fields.push(`amount = $${idx++}`); vals.push(amt);
    }
    if (typeof body.category === 'string') { fields.push(`category = $${idx++}`); vals.push(body.category.trim()); }
    if (typeof body.description === 'string') { fields.push(`description = $${idx++}`); vals.push(body.description.trim()); }
    if (typeof body.paidTo === 'string') { fields.push(`paid_to = $${idx++}`); vals.push(body.paidTo.trim()); }
    if (body.date) { fields.push(`date = $${idx++}`); vals.push(new Date(body.date)); }
    if (body.enabled !== undefined) { fields.push(`enabled = $${idx++}`); vals.push(!(body.enabled === false || body.enabled === 'false')); }

    fields.push(`updated_at = now()`);
    vals.push(id);
    const { rows } = await pool.query(`UPDATE expenses SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense updated', expense: rowToExpense(rows[0]) });
  } catch (err) {
    console.error('update expense error:', err);
    res.status(500).send('Update expense failed');
  }
});

app.post('/api/expenses/:id/enable', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    const { rows } = await pool.query(`UPDATE expenses SET enabled=$1, updated_at=now() WHERE id=$2 RETURNING *`, [enabled, id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ ok: true, expense: rowToExpense(rows[0]) });
  } catch (e) {
    console.error('enable expense error:', e);
    res.status(500).send('Failed to enable/disable expense');
  }
});

app.post('/admin/expenses/:id/approve', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const approveRaw = req.body.approve;
    const approve = (approveRaw === true || approveRaw === 'true' || approveRaw === 1 || approveRaw === '1');

    const { rows } = await pool.query(
      `UPDATE expenses SET approved=$1, status=$2, approved_by=$3, approved_by_id=$4, approved_at=$5, updated_at=now()
       WHERE id=$6 RETURNING *`,
      [approve, approve ? 'approved' : 'pending', req.user.username, req.user.id, approve ? new Date() : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });

    const e = rowToExpense(rows[0]);
    const who = e.submittedBy || null;
    if (who) {
      pushNotification(who, {
        type: `expense${approve ? 'Approval' : 'Pending'}`,
        title: `Expense ${approve ? 'approved' : 'set to pending'}`,
        body: `${e.category} � ?${e.amount}`,
        data: { id: e.id, category: e.category, approved: approve },
      });
    }
    res.json({ message: `Expense ${approve ? 'approved' : 'set to pending'}`, expense: e });
  } catch (e) {
    console.error('approve expense error:', e);
    res.status(500).send('Approval failed');
  }
});

app.delete('/api/expenses/:id', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const { rows } = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING *', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted', expense: rowToExpense(rows[0]) });
  } catch (err) {
    console.error('delete expense error:', err);
    res.status(500).send('Delete expense failed');
  }
});

/* ===================== Donations (Postgres + Cloudinary screenshot) ===================== */
const donationScreenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'setapur/screenshots', allowed_formats: ['jpg','jpeg','png','webp','gif'], resource_type: 'image' },
});
const uploadDonation = multer({ storage: donationScreenshotStorage, limits: { fileSize: 20 * 1024 * 1024 } });

async function receiptCodeExists(code) {
  const { rows } = await pool.query('SELECT 1 FROM donations WHERE upper(receipt_code) = upper($1) LIMIT 1', [code]);
  return rows.length > 0;
}
async function generateUniqueReceiptCodeDB() {
  let code, tries=0;
  do { code = generate6CharAlnumMix(); tries++; } while (tries<1000 && await receiptCodeExists(code));
  return code;
}
function rowToDonation(r) {
  return {
    id: r.id,
    donorUserId: r.donor_user_id,
    donorUsername: r.donor_username,
    donorName: r.donor_name,
    amount: Number(r.amount),
    paymentMethod: r.payment_method,
    category: r.category,
    cashReceiverName: r.cash_receiver_name,
    approved: r.approved,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    screenshotPath: r.screenshot_public_id,
    screenshotUrl: r.screenshot_url,
    code: r.receipt_code,
    receiptCode: r.receipt_code,
    approvedBy: r.approved_by,
    approvedById: r.approved_by_id,
    approvedByRole: r.approved_by_role,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at
  };
}

async function createDonationHandler(req, res) {
  try {
    await ensureDonationsTable();
    const { amount, paymentMethod, category, cashReceiverName, donorName } = req.body || {};
    if (!donorName || !String(donorName).trim()) return res.status(400).json({ error: 'donorName is required' });
    if (!amount || !paymentMethod || !category) return res.status(400).json({ error: 'amount, paymentMethod, and category are required' });

    const code = await generateUniqueReceiptCodeDB();
    const screenshotUrl = req.file?.path || null;
    const screenshotPublicId = req.file?.filename || null;

    const { rows } = await pool.query(
      `INSERT INTO donations
       (donor_user_id, donor_username, donor_name, amount, payment_method, category, cash_receiver_name,
        approved, status, created_at, updated_at, screenshot_public_id, screenshot_url, receipt_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,'pending',now(),now(),$8,$9,$10)
       RETURNING *`,
      [req.user.id, req.user.username, String(donorName).trim(), Number(amount), paymentMethod, category,
       cashReceiverName || null, screenshotPublicId, screenshotUrl, code]
    );
    res.status(201).json({ message: 'Donation submitted', donation: rowToDonation(rows[0]) });
  } catch (err) {
    console.error('submit-donation error:', err);
    res.status(500).send('Failed to submit donation');
  }
}

app.post('/api/donations/submit-donation',
  authRole(['user','admin','mainadmin']),
  uploadDonation.single('screenshot'),
  createDonationHandler
);
// Alias direct to same handler
app.post('/api/donations/create',
  authRole(['user','admin','mainadmin']),
  uploadDonation.single('screenshot'),
  createDonationHandler
);

app.get('/myaccount/receipts', authRole(['user','admin','mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const username = req.user.username;
  const { rows } = await pool.query(
    `SELECT * FROM donations WHERE approved = true AND (
      donor_username = $1 OR donor_name = $1
    ) ORDER BY created_at DESC`, [username]
  );
  res.json(rows.map(rowToDonation));
});

app.get('/api/donations/donations', authRole(['user','admin','mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const status = String(req.query.status || 'approved').toLowerCase();
  const role = req.user.role;
  const q = (req.query.q || req.query.search || '').toString().trim();

  if ((role === 'admin' || role === 'mainadmin') && status === 'all') {
    let sql = 'SELECT * FROM donations';
    let vals = [];
    if (q) {
      sql += ` WHERE lower(coalesce(donor_name,'')) ILIKE lower($1)
            OR lower(coalesce(donor_username,'')) ILIKE lower($1)
            OR lower(coalesce(receipt_code,'')) ILIKE lower($1)
            OR lower(coalesce(category,'')) ILIKE lower($1)`;
      vals = [`%${q}%`];
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(sql, vals);
    return res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
  }

  // mine
  let where = ` WHERE (donor_username = $1 OR donor_name = $1)`;
  const vals = [req.user.username];
  if (status === 'pending') where += ' AND approved = false';
  else if (status === 'approved') where += ' AND approved = true';
  if (q) {
    where += ` AND (lower(coalesce(donor_name,'')) ILIKE lower($2)
                OR lower(coalesce(receipt_code,'')) ILIKE lower($2)
                OR lower(coalesce(category,'')) ILIKE lower($2))`;
    vals.push(`%${q}%`);
  }
  const { rows } = await pool.query(`SELECT * FROM donations ${where} ORDER BY created_at DESC`, vals);
  res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
});

app.get('/api/donations/all-donations', authRole(['admin', 'mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const role = req.user.role;
  const q = (req.query.q || req.query.search || '').toString().trim();
  let sql = 'SELECT * FROM donations';
  let vals = [];
  if (q) {
    sql += ` WHERE lower(coalesce(donor_name,'')) ILIKE lower($1)
          OR lower(coalesce(donor_username,'')) ILIKE lower($1)
          OR lower(coalesce(receipt_code,'')) ILIKE lower($1)
          OR lower(coalesce(category,'')) ILIKE lower($1)`;
    vals = [`%${q}%`];
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, vals);
  res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
});

app.get('/api/donations/search', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const role = req.user.role;
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.q || req.query.search || '').toString().trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    let sql, vals;
    if (isAdmin) {
      sql = `SELECT * FROM donations
             WHERE lower(coalesce(donor_name,'')) ILIKE lower($1)
                OR lower(coalesce(donor_username,'')) ILIKE lower($1)
                OR lower(coalesce(receipt_code,'')) ILIKE lower($1)
                OR lower(coalesce(category,'')) ILIKE lower($1)
             ORDER BY created_at DESC LIMIT 100`;
      vals = [like];
    } else {
      sql = `SELECT * FROM donations
             WHERE approved = true
               AND (lower(coalesce(donor_name,'')) ILIKE lower($1)
                 OR lower(coalesce(receipt_code,'')) ILIKE lower($1)
                 OR lower(coalesce(category,'')) ILIKE lower($1))
             UNION ALL
             SELECT * FROM donations
              WHERE donor_username = $2 AND approved = false
                AND (lower(coalesce(donor_name,'')) ILIKE lower($1)
                  OR lower(coalesce(receipt_code,'')) ILIKE lower($1)
                  OR lower(coalesce(category,'')) ILIKE lower($1))
             ORDER BY created_at DESC LIMIT 100`;
      vals = [like, req.user.username];
    }
    const { rows } = await pool.query(sql, vals);
    res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
  } catch (e) {
    console.error('donation search error:', e);
    res.status(500).send('Search failed');
  }
});

app.get('/admin/donations/pending', authRole(['admin', 'mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const { rows } = await pool.query(`SELECT * FROM donations WHERE approved = false ORDER BY created_at DESC`);
  res.json(rows.map(rowToDonation));
});

app.post('/admin/donations/:id/approve', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { id } = req.params;
    const { rows: curRows } = await pool.query('SELECT * FROM donations WHERE id=$1', [id]);
    if (!curRows.length) return res.status(404).json({ error: 'Donation not found' });
    let d = curRows[0];

    // ensure receipt code valid
    let rc = (d.receipt_code || '').toUpperCase();
    const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
    if (!valid) rc = await generateUniqueReceiptCodeDB();

    // approver display name
    let approvedByName = req.user.username;
    try {
      const users = await getUsers();
      const approver = users.find(u => u.username === req.user.username);
      approvedByName = approver?.name || approver?.fullName || approver?.displayName || approvedByName;
    } catch {}

    const alreadyApproved = d.approved === true;

    const { rows: upd } = await pool.query(
      `UPDATE donations SET
         approved=true, status='approved',
         approved_by=$1, approved_by_id=$2, approved_by_role=$3, approved_by_name=$4, approved_at=now(),
         receipt_code=$5, updated_at=now()
       WHERE id=$6
       RETURNING *`,
      [req.user.username, req.user.id, req.user.role, approvedByName, rc, id]
    );
    const out = rowToDonation(upd[0]);

    if (!alreadyApproved) {
      const donorUser = out.donorUsername || out.donorName || null;
      const rcOut = out.receiptCode || out.code || '';
      if (donorUser) {
        pushNotification(donorUser, {
          type: 'donationApproval',
          title: 'Donation approved',
          body: `Receipt: ${rcOut || 'N/A'} � Event: ${out.category} � Amount: ?${pgNum(out.amount)}`,
          data: { receiptCode: rcOut || null, category: out.category, amount: out.amount, paymentMethod: out.paymentMethod, approved: true },
        });
      }
    }

    res.json({ message: 'Donation approved', donation: out });
  } catch (err) {
    console.error('admin approve error:', err);
    return res.status(500).send('Approval failed');
  }
});

app.post('/admin/donations/:id/disapprove', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE donations SET approved=false, status='pending',
       approved_by=NULL, approved_by_id=NULL, approved_by_role=NULL, approved_by_name=NULL, approved_at=NULL, updated_at=now()
       WHERE id=$1 RETURNING *`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    res.json({ message: 'Donation set to pending', donation: rowToDonation(rows[0]) });
  } catch (err) {
    console.error('admin disapprove error:', err);
    return res.status(500).send('Disapprove failed');
  }
});

async function handleDonationUpdate(req, res) {
  try {
    await ensureDonationsTable();
    const { id } = req.params;
    const body = req.body || {};

    const fields = []; const vals = []; let idx = 1;

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      fields.push(`amount = $${idx++}`); vals.push(amt);
    }
    if (typeof body.donorName === 'string') { fields.push(`donor_name = $${idx++}`); vals.push(body.donorName.trim()); }
    if (typeof body.category === 'string') { fields.push(`category = $${idx++}`); vals.push(body.category.trim()); }
    if (typeof body.paymentMethod === 'string') { fields.push(`payment_method = $${idx++}`); vals.push(body.paymentMethod.trim()); }
    if (typeof body.cashReceiverName === 'string') { fields.push(`cash_receiver_name = $${idx++}`); vals.push(body.cashReceiverName.trim()); }

    if (typeof body.receiptCode === 'string' && body.receiptCode.trim()) {
      const rc = body.receiptCode.trim().toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      if (!valid) return res.status(400).json({ error: 'receiptCode must be 6-char A-Z0-9 with at least 1 letter & 1 digit' });
      // uniqueness
      const { rows: dup } = await pool.query('SELECT 1 FROM donations WHERE upper(receipt_code) = upper($1) AND id <> $2 LIMIT 1', [rc, id]);
      if (dup.length) return res.status(409).json({ error: 'receiptCode already exists' });
      fields.push(`receipt_code = $${idx++}`); vals.push(rc);
    }
    if (body.regenerateReceiptCode === true || body.regenerateReceiptCode === 'true') {
      const rc = await generateUniqueReceiptCodeDB();
      fields.push(`receipt_code = $${idx++}`); vals.push(rc);
    }

    fields.push(`updated_at = now()`);
    vals.push(id);
    const { rows } = await pool.query(`UPDATE donations SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    res.json({ message: 'Donation updated', donation: rowToDonation(rows[0]) });
  } catch (e) {
    console.error('update donation error:', e);
    res.status(500).send('Update donation failed');
  }
}
app.put('/admin/donations/:id', authRole(['admin', 'mainadmin']), handleDonationUpdate);
app.put('/api/donations/:id', authRole(['admin', 'mainadmin']), handleDonationUpdate);

/* ===================== Gallery (Cloudinary + Postgres) ===================== */
const ALLOWED_ICON_KEYS = new Set([
  'temple','event','flower','music','book','home','star','people','calendar','camera','donation','festival'
]);

const uploadGalleryCloud = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const slug = String(req.params.slug || req.query.slug || '_root').trim() || '_root';
      const base = path.basename(file.originalname || 'image', path.extname(file.originalname || ''));
      const safeBase = slugify(base) || 'img';
      return {
        folder: `setapur/gallery/${slug}`,
        public_id: `${Date.now()}-${Math.round(Math.random()*1e9)}-${safeBase}`,
        allowed_formats: ['jpg','jpeg','png','webp','gif'],
        resource_type: 'image'
      };
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 25 },
});

async function ensureGalleryFolder(slug, name) {
  await ensureGalleryTables();
  const s = slug || '_root';
  const n = name || s.replace(/-/g, ' ');
  await pool.query(
    `INSERT INTO gallery_folders (slug, name, enabled, order_index)
     VALUES ($1,$2,true, COALESCE((SELECT COALESCE(MAX(order_index),-1)+1 FROM gallery_folders),0))
     ON CONFLICT (slug) DO NOTHING`,
    [s, n]
  );
}

async function reorderGalleryImages(folderSlug, targetIdOrName, direction, newIndex) {
  const { rows } = await pool.query('SELECT id, filename FROM gallery_images WHERE folder_slug=$1 ORDER BY order_index ASC, lower(filename) ASC', [folderSlug]);
  let list = rows.map(r => ({ id: r.id, name: r.filename }));
  let idx = list.findIndex(x => String(x.id) === String(targetIdOrName) || String(x.name) === String(targetIdOrName));
  if (idx === -1) return;

  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const item = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, item);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx >= 0 && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) {
    await pool.query('UPDATE gallery_images SET order_index=$1 WHERE id=$2', [i, list[i].id]);
  }
}

async function reorderGalleryFolders(slug, direction, newIndex) {
  const { rows } = await pool.query('SELECT slug FROM gallery_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.slug);
  let idx = list.indexOf(slug);
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const item = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, item);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx >= 0 && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) {
    await pool.query('UPDATE gallery_folders SET order_index=$1 WHERE slug=$2', [i, list[i]]);
  }
}

// List folders
app.get('/gallery/folders', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    let sql = 'SELECT slug, name, enabled, order_index, cover_url, icon_public_id, icon_key FROM gallery_folders';
    if (!isAdmin && !includeDisabled) sql += ' WHERE enabled = true';
    sql += ' ORDER BY order_index ASC, lower(name) ASC';
    const { rows } = await pool.query(sql);
    const foldersOut = rows.map(r => ({
      name: r.name,
      slug: r.slug,
      url: null,
      cover: null,
      coverUrl: r.cover_url || null,
      iconFile: null,
      iconUrl: null,
      iconKey: r.icon_key || null,
      enabled: r.enabled !== false,
      order: r.order_index || 0,
    }));
    res.json(foldersOut);
  } catch (e) {
    console.error('gallery list error:', e);
    res.status(500).send('Failed to list gallery folders');
  }
});

// Create folder
app.post('/gallery/folders/create', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    await pool.query(
      `INSERT INTO gallery_folders (slug, name, enabled, order_index)
       VALUES ($1,$2,true, COALESCE((SELECT COALESCE(MAX(order_index),-1)+1 FROM gallery_folders),0))`,
      [slug, String(name).trim()]
    );
    res.status(201).json({ name: String(name).trim(), slug });
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('duplicate')) return res.status(409).json({ error: 'folder already exists' });
    console.error('gallery create error:', e);
    res.status(500).send('Failed to create folder');
  }
});

// Upload images (folder)
app.post('/gallery/folders/:slug/upload',
  authRole(['admin', 'mainadmin']),
  uploadGalleryCloud.array('images', 25),
  insertGalleryUploadsToDB
);

// Root images: list
async function listRootGalleryImages(req, res) {
  try {
    await ensureGalleryTables();
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());

    await ensureGalleryFolder('_root', 'Home');
    let sql = 'SELECT id, filename, url, enabled, order_index, uploaded_at FROM gallery_images WHERE folder_slug=$1';
    const vals = ['_root'];
    if (!isAdmin && !includeDisabled) sql += ' AND enabled = true';
    sql += ' ORDER BY order_index ASC, lower(filename) ASC';
    const { rows } = await pool.query(sql, vals);
    res.json(rows.map(r => ({
      name: r.filename,
      url: r.url,
      size: null,
      modifiedAt: r.uploaded_at,
      enabled: r.enabled,
      order: r.order_index
    })));
  } catch (e) {
    console.error('gallery root images error:', e);
    res.status(500).send('Failed to list gallery images');
  }
}
app.get('/gallery/images', authRole(['user', 'admin', 'mainadmin']), listRootGalleryImages);
app.get('/gallery/home/images', authRole(['user', 'admin', 'mainadmin']), listRootGalleryImages);

// Root/folder uploads shared DB inserter
async function insertGalleryUploadsToDB(req, res) {
  try {
    await ensureGalleryTables();
    const slug = String(req.params.slug || '_root');
    await ensureGalleryFolder(slug, slug === '_root' ? 'Home' : slug);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const { rows: r0 } = await pool.query('SELECT COALESCE(MAX(order_index), -1) AS m FROM gallery_images WHERE folder_slug=$1', [slug]);
    let order = Number(r0[0]?.m || -1) + 1;

    const inserted = [];
    for (const f of files) {
      const filename = path.basename(f.originalname || 'image').replace(/\s+/g,'-');
      const { rows } = await pool.query(
        `INSERT INTO gallery_images (folder_slug, public_id, url, filename, enabled, order_index, bytes)
         VALUES ($1,$2,$3,$4,true,$5,NULL) RETURNING *`,
        [slug, f.filename, f.path, filename, order++]
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ uploaded: inserted.map(r => ({ id:r.id, filename:r.filename, url:r.url })), count: inserted.length });
  } catch (e) { console.error('gallery upload error:', e); res.status(500).send('Upload failed'); }
}

// Root upload
app.post('/gallery/upload',
  authRole(['admin', 'mainadmin']),
  (req, _res, next) => { req.params.slug = '_root'; next(); },
  uploadGalleryCloud.array('images', 25),
  insertGalleryUploadsToDB
);
// Home alias
app.post('/gallery/home/upload',
  authRole(['admin', 'mainadmin']),
  (req, _res, next) => { req.params.slug = '_root'; next(); },
  uploadGalleryCloud.array('images', 25),
  insertGalleryUploadsToDB
);

// List images in folder
app.get('/gallery/folders/:slug/images', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';

    let sql = 'SELECT id, filename, url, enabled, order_index, uploaded_at FROM gallery_images WHERE folder_slug=$1';
    const vals = [slug];
    if (!isAdmin && !includeDisabled) {
      sql += ' AND enabled = true';
    }
    sql += ' ORDER BY order_index ASC, lower(filename) ASC';
    const { rows } = await pool.query(sql, vals);

    res.json(rows.map(r => ({
      id: r.id,
      name: r.filename,
      url: r.url,
      enabled: r.enabled,
      modifiedAt: r.uploaded_at
    })));
  } catch (e) {
    console.error('gallery images error:', e);
    res.status(500).send('Failed to list images');
  }
});

// Enable/disable folder
app.post('/gallery/folders/:slug/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    const { rows } = await pool.query('UPDATE gallery_folders SET enabled=$1 WHERE slug=$2 RETURNING slug, name, enabled', [enabled, slug]);
    if (!rows.length) return res.status(404).json({ error: 'folder not found' });
    res.json({ ok: true, slug, enabled: rows[0].enabled });
  } catch (e) {
    console.error('enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

// Reorder folders
app.post('/gallery/folders/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug, direction, newIndex } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    await reorderGalleryFolders(slug, direction, typeof newIndex === 'number' ? newIndex : undefined);
    const { rows } = await pool.query('SELECT slug FROM gallery_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok: true, folderOrder: rows.map(r => r.slug) });
  } catch (e) {
    console.error('reorder folders error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});
app.post('/gallery/folders/:slug/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { direction, newIndex } = req.body || {};
    await reorderGalleryFolders(slug, direction, typeof newIndex === 'number' ? newIndex : undefined);
    const { rows } = await pool.query('SELECT slug FROM gallery_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok: true, folderOrder: rows.map(r => r.slug) });
  } catch (e) {
    console.error('reorder folders (param) error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});

// Rename folder
app.post('/gallery/folders/:slug/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    let { name, newName } = req.body || {};
    const desired = String((name || newName || '')).trim();
    if (!desired) return res.status(400).json({ error: 'name (or newName) required' });
    const newSlug = slugify(desired);
    if (!newSlug) return res.status(400).json({ error: 'invalid newName' });

    const { rows: exists } = await pool.query('SELECT 1 FROM gallery_folders WHERE slug=$1', [slug]);
    if (!exists.length) return res.status(404).json({ error: 'folder not found' });

    const { rows: dup } = await pool.query('SELECT 1 FROM gallery_folders WHERE slug=$1', [newSlug]);
    if (dup.length && newSlug !== slug) return res.status(409).json({ error: 'target exists', slug: newSlug });

    await pool.query('BEGIN');
    await pool.query('UPDATE gallery_images SET folder_slug=$1 WHERE folder_slug=$2', [newSlug, slug]);
    await pool.query('UPDATE gallery_folders SET slug=$1, name=$2 WHERE slug=$3', [newSlug, desired, slug]);
    await pool.query('COMMIT');

    res.json({ ok: true, slug: newSlug, name: desired });
  } catch (e) {
    await pool.query('ROLLBACK').catch(()=>{});
    console.error('rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

// Delete folder
app.delete('/gallery/folders/:slug', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;

    // Optional Cloudinary cleanup
    try {
      const prefix = `setapur/gallery/${slug}`;
      const { resources } = await cloudinary.search.expression(`folder:${prefix}`).max_results(500).execute();
      for (const r of (resources || [])) {
        await cloudinary.uploader.destroy(r.public_id, { resource_type: 'image' });
      }
    } catch (e) { console.warn('Cloudinary folder cleanup failed (non-fatal):', e.message); }

    const { rowCount } = await pool.query('DELETE FROM gallery_folders WHERE slug=$1', [slug]);
    if (!rowCount) return res.status(404).json({ error: 'folder not found' });
    res.json({ ok: true, slug });
  } catch (e) {
    console.error('delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

// Reorder images in folder
app.post('/gallery/folders/:slug/images/reorder', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { filename, id, direction, newIndex } = req.body || {};
    const target = id || filename;
    if (!target) return res.status(400).json({ error: 'id or filename required' });
    await reorderGalleryImages(slug, target, direction, typeof newIndex === 'number' ? newIndex : undefined);
    const { rows } = await pool.query('SELECT filename FROM gallery_images WHERE folder_slug=$1 ORDER BY order_index ASC, lower(filename) ASC', [slug]);
    res.json({ ok: true, imageOrder: rows.map(r => r.filename) });
  } catch (e) {
    console.error('reorder images error:', e);
    res.status(500).send('Failed to reorder images');
  }
});

// Enable/disable image
app.post('/gallery/folders/:slug/images/enable', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { filename, id } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    if (!filename && !id) return res.status(400).json({ error: 'id or filename required' });

    const cond = id ? 'id=$1 AND folder_slug=$2' : 'filename=$1 AND folder_slug=$2';
    const vals = id ? [id, slug] : [String(filename), slug];
    const { rows } = await pool.query(`UPDATE gallery_images SET enabled=$3 WHERE ${cond} RETURNING *`, [...vals, enabled]);
    if (!rows.length) return res.status(404).json({ error: 'image not found' });
    res.json({ ok: true, filename: rows[0].filename, enabled: rows[0].enabled });
  } catch (e) {
    console.error('enable image error:', e);
    res.status(500).send('Failed to update image enabled');
  }
});

// Rename image (Cloudinary rename + DB update)
app.post('/gallery/folders/:slug/images/rename', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { id, filename, newName } = req.body || {};
    if (!newName) return res.status(400).json({ error: 'newName required' });

    let row = null;
    if (id) {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE id=$1 AND folder_slug=$2', [id, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    } else if (filename) {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE filename=$1 AND folder_slug=$2', [filename, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    } else return res.status(400).json({ error: 'id or filename required' });

    const base = path.basename(newName, path.extname(newName));
    const safeBase = slugify(base) || 'img';
    const newPublicId = `setapur/gallery/${slug}/${Date.now()}-${Math.round(Math.random()*1e9)}-${safeBase}`;

    await cloudinary.uploader.rename(row.public_id, newPublicId, { resource_type: 'image' });
    const newUrl = cloudinary.url(newPublicId, { secure: true });

    const { rows: upd } = await pool.query(
      'UPDATE gallery_images SET public_id=$1, url=$2, filename=$3 WHERE id=$4 RETURNING *',
      [newPublicId, newUrl, `${safeBase}${path.extname(row.filename)}`, row.id]
    );

    res.json({ ok: true, filename: upd[0].filename, url: upd[0].url });
  } catch (e) {
    console.error('rename image error:', e);
    res.status(500).send('Failed to rename image');
  }
});

// Delete image
app.delete('/gallery/folders/:slug/images', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const filename = req.query.filename || (req.body && req.body.filename);
    const id = req.query.id || (req.body && req.body.id);
    if (!filename && !id) return res.status(400).json({ error: 'id or filename required' });

    let row = null;
    if (id) {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE id=$1 AND folder_slug=$2', [id, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    } else {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE filename=$1 AND folder_slug=$2', [filename, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    }

    try { await cloudinary.uploader.destroy(row.public_id, { resource_type: 'image' }); } catch (e) { console.warn('cloud delete failed', e.message); }
    await pool.query('DELETE FROM gallery_images WHERE id=$1', [row.id]);

    res.json({ ok: true, filename: row.filename });
  } catch (e) {
    console.error('delete image error:', e);
    res.status(500).send('Failed to delete file');
  }
});

// Set cover
app.post('/gallery/folders/:slug/cover', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { filename, id } = req.body || {};
    if (!filename && !id) return res.status(400).json({ error: 'id or filename required' });

    const cond = id ? 'id=$1 AND folder_slug=$2' : 'filename=$1 AND folder_slug=$2';
    const vals = id ? [id, slug] : [String(filename), slug];
    const { rows } = await pool.query(`SELECT * FROM gallery_images WHERE ${cond}`, vals);
    if (!rows.length) return res.status(404).json({ error: 'image not found' });

    const img = rows[0];
    await pool.query('UPDATE gallery_folders SET cover_public_id=$1, cover_url=$2 WHERE slug=$3', [img.public_id, img.url, slug]);
    res.json({ ok: true, slug, cover: img.filename, coverUrl: img.url });
  } catch (e) {
    console.error('set cover error:', e);
    res.status(500).send('Failed to set cover');
  }
});

// Set/Clear icon
app.post('/gallery/folders/:slug/icon', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const { slug } = req.params;
    const { filename, imageId, iconKey, clear } = req.body || {};

    if (clear === true || clear === 'true' || clear === 1 || clear === '1') {
      await pool.query('UPDATE gallery_folders SET icon_public_id=NULL, icon_key=NULL WHERE slug=$1', [slug]);
      return res.json({ ok: true, slug, iconFile: null, iconKey: null, iconUrl: null });
    }

    if (iconKey && String(iconKey).trim()) {
      const key = String(iconKey).trim();
      if (!ALLOWED_ICON_KEYS.has(key)) return res.status(400).json({ error: 'Invalid iconKey', allowed: Array.from(ALLOWED_ICON_KEYS) });
      await pool.query('UPDATE gallery_folders SET icon_public_id=NULL, icon_key=$1 WHERE slug=$2', [key, slug]);
      return res.json({ ok: true, slug, iconFile: null, iconKey: key, iconUrl: null });
    }

    let row = null;
    if (imageId) {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE id=$1 AND folder_slug=$2', [imageId, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    } else if (filename) {
      const { rows } = await pool.query('SELECT * FROM gallery_images WHERE filename=$1 AND folder_slug=$2', [filename, slug]);
      if (!rows.length) return res.status(404).json({ error: 'image not found' });
      row = rows[0];
    } else return res.status(400).json({ error: 'Provide imageId OR filename OR iconKey OR clear=true' });

    await pool.query('UPDATE gallery_folders SET icon_public_id=$1, icon_key=NULL WHERE slug=$2', [row.public_id, slug]);
    return res.json({ ok: true, slug, iconFile: row.filename, iconKey: null, iconUrl: row.url });
  } catch (e) {
    console.error('set icon error:', e);
    res.status(500).send('Failed to set icon');
  }
});

/* ===================== E-Books (Cloudinary raw + Postgres) ===================== */
const uploadEbooksCloud = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const slug = req.params.slug ? String(req.params.slug).trim() : null;
      const folder = slug ? `setapur/ebooks/${slug}` : 'setapur/ebooks';
      const base = path.basename(file.originalname || 'file', path.extname(file.originalname || ''));
      const safeBase = slugify(base) || 'file';
      return {
        folder,
        public_id: `${Date.now()}-${Math.round(Math.random()*1e9)}-${safeBase}`,
        resource_type: 'raw',
        allowed_formats: ['pdf']
      };
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 25 },
});

app.get('/ebooks/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());
    let sql = 'SELECT slug, name, enabled FROM ebook_folders';
    if (!isAdmin && !includeDisabled) sql += ' WHERE enabled = true';
    sql += ' ORDER BY lower(name) ASC';
    const { rows } = await pool.query(sql);
    const out = [];
    for (const f of rows) {
      const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM ebook_files WHERE folder_slug=$1', [f.slug]);
      out.push({
        name: f.name,
        slug: f.slug,
        url: null,
        fileCount: cnt[0].c,
        enabled: f.enabled !== false
      });
    }
    res.json(out);
  } catch (e) {
    console.error('ebooks folders error:', e);
    res.status(500).send('Failed to list e-book folders');
  }
});

app.get('/ebooks/files', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());
    let sql = 'SELECT id, filename, url, enabled, order_index, uploaded_at FROM ebook_files WHERE folder_slug IS NULL';
    if (!isAdmin && !includeDisabled) sql += ' AND enabled = true';
    sql += ' ORDER BY order_index ASC, lower(filename) ASC';
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error('ebooks root files error:', e);
    res.status(500).send('Failed to list e-books');
  }
});

app.get('/ebooks/folders/:slug/files', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { slug } = req.params;
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());

    let sql = 'SELECT id, filename, url, enabled, order_index, uploaded_at FROM ebook_files WHERE folder_slug=$1';
    const vals=[slug];
    if (!isAdmin && !includeDisabled) sql += ' AND enabled = true';
    sql += ' ORDER BY order_index ASC, lower(filename) ASC';
    const { rows } = await pool.query(sql, vals);
    res.json(rows);
  } catch (e) {
    console.error('ebooks folder files error:', e);
    res.status(500).send('Failed to list e-books in folder');
  }
});

app.post('/ebooks/folders/create', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    await pool.query('INSERT INTO ebook_folders (slug, name, enabled) VALUES ($1,$2,true)', [slug, String(name).trim()]);
    res.status(201).json({ name: String(name).trim(), slug });
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('duplicate')) return res.status(409).json({ error: 'folder already exists' });
    console.error('ebooks create folder error:', e);
    res.status(500).send('Failed to create folder');
  }
});

app.post('/ebooks/folders/:slug/rename', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { slug } = req.params;
    const { name, newName } = req.body || {};
    const desired = String((name || newName || '')).trim();
    if (!desired) return res.status(400).json({ error: 'name (or newName) required' });
    const newSlug = slugify(desired);

    const { rows: exists } = await pool.query('SELECT 1 FROM ebook_folders WHERE slug=$1', [slug]);
    if (!exists.length) return res.status(404).json({ error: 'folder not found' });
    const { rows: dup } = await pool.query('SELECT 1 FROM ebook_folders WHERE slug=$1', [newSlug]);
    if (dup.length && newSlug !== slug) return res.status(409).json({ error: 'target exists', slug: newSlug });

    await pool.query('BEGIN');
    await pool.query('UPDATE ebook_files SET folder_slug=$1 WHERE folder_slug=$2', [newSlug, slug]);
    await pool.query('UPDATE ebook_folders SET slug=$1, name=$2 WHERE slug=$3', [newSlug, desired, slug]);
    await pool.query('COMMIT');

    res.json({ ok: true, slug: newSlug, name: desired });
  } catch (e) {
    await pool.query('ROLLBACK').catch(()=>{});
    console.error('ebooks rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

app.post('/ebooks/folders/:slug/enable', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    const { rows } = await pool.query('UPDATE ebook_folders SET enabled=$1 WHERE slug=$2 RETURNING *', [enabled, slug]);
    if (!rows.length) return res.status(404).json({ error: 'folder not found' });
    res.json({ ok: true, slug, enabled: rows[0].enabled });
  } catch (e) {
    console.error('ebooks enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

app.delete('/ebooks/folders/:slug', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { slug } = req.params;

    // Optional Cloudinary cleanup
    try {
      const prefix = `setapur/ebooks/${slug}`;
      const { resources } = await cloudinary.search.expression(`folder:${prefix}`).max_results(500).execute();
      for (const r of (resources || [])) {
        await cloudinary.uploader.destroy(r.public_id, { resource_type: 'raw' });
      }
    } catch (e) { console.warn('Cloudinary ebooks folder cleanup failed (non-fatal):', e.message); }

    const { rowCount } = await pool.query('DELETE FROM ebook_folders WHERE slug=$1', [slug]);
    if (!rowCount) return res.status(404).json({ error: 'folder not found' });
    res.json({ ok: true, slug });
  } catch (e) {
    console.error('ebooks delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

app.post('/ebooks/upload', authRole(['admin','mainadmin']), uploadEbooksCloud.array('files', 25), async (req, res) => {
  try {
    await ensureEbooksTables();
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const { rows: r0 } = await pool.query('SELECT COALESCE(MAX(order_index), -1) AS m FROM ebook_files WHERE folder_slug IS NULL');
    let order = Number(r0[0]?.m || -1) + 1;

    const inserted = [];
    for (const f of files) {
      const filename = path.basename(f.originalname || 'file').replace(/\s+/g,'-');
      const { rows } = await pool.query(
        `INSERT INTO ebook_files (folder_slug, public_id, url, filename, enabled, order_index)
         VALUES (NULL,$1,$2,$3,true,$4) RETURNING *`,
        [f.filename, f.path, filename, order++]
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ uploaded: inserted.map(r => ({ id:r.id, filename:r.filename, url:r.url })), count: inserted.length });
  } catch (e){ console.error('ebooks root upload error:', e); res.status(500).send('Upload failed'); }
});

app.post('/ebooks/folders/:slug/upload', authRole(['admin','mainadmin']), uploadEbooksCloud.array('files', 25), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { slug } = req.params;
    await pool.query(`INSERT INTO ebook_folders (slug,name,enabled) VALUES ($1,$1,true) ON CONFLICT (slug) DO NOTHING`, [slug]);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const { rows: r0 } = await pool.query('SELECT COALESCE(MAX(order_index), -1) AS m FROM ebook_files WHERE folder_slug=$1',[slug]);
    let order = Number(r0[0]?.m || -1) + 1;

    const inserted=[];
    for (const f of files) {
      const filename = path.basename(f.originalname || 'file').replace(/\s+/g,'-');
      const { rows } = await pool.query(
        `INSERT INTO ebook_files (folder_slug, public_id, url, filename, enabled, order_index)
         VALUES ($1,$2,$3,$4,true,$5) RETURNING *`,
        [slug, f.filename, f.path, filename, order++]
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ uploaded: inserted.map(r => ({ id:r.id, filename:r.filename, url:r.url })), count: inserted.length, folder: slug });
  } catch (e){ console.error('ebooks folder upload error:', e); res.status(500).send('Upload failed'); }
});

app.post('/ebooks/files/rename', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { id, filename, folderSlug, newName } = req.body || {};
    if (!newName) return res.status(400).json({ error: 'newName required' });

    let row = null;
    if (id) {
      const { rows } = await pool.query('SELECT * FROM ebook_files WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else if (filename) {
      const cond = folderSlug ? 'filename=$1 AND folder_slug=$2' : 'filename=$1 AND folder_slug IS NULL';
      const vals = folderSlug ? [filename, folderSlug] : [filename];
      const { rows } = await pool.query(`SELECT * FROM ebook_files WHERE ${cond}`, vals);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else return res.status(400).json({ error: 'id or filename required' });

    const base = path.basename(newName, path.extname(newName));
    const safeBase = slugify(base) || 'file';
    const newPublicId = (row.folder_slug ? `setapur/ebooks/${row.folder_slug}/` : 'setapur/ebooks/') + `${Date.now()}-${Math.round(Math.random()*1e9)}-${safeBase}`;

    await cloudinary.uploader.rename(row.public_id, newPublicId, { resource_type: 'raw' });
    const newUrl = cloudinary.url(newPublicId, { resource_type: 'raw', secure: true });

    const { rows: upd } = await pool.query(
      'UPDATE ebook_files SET public_id=$1, url=$2, filename=$3 WHERE id=$4 RETURNING *',
      [newPublicId, newUrl, `${safeBase}${path.extname(row.filename)}`, row.id]
    );
    res.json({ ok: true, filename: upd[0].filename, url: upd[0].url });
  } catch (e) {
    console.error('ebooks root rename error:', e);
    res.status(500).send('Failed to rename file');
  }
});

app.post('/ebooks/files/enable', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { id, filename, folderSlug } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    let row = null;

    if (id) {
      const { rows } = await pool.query('UPDATE ebook_files SET enabled=$1 WHERE id=$2 RETURNING *', [enabled, id]);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else if (filename) {
      const cond = folderSlug ? 'filename=$1 AND folder_slug=$2' : 'filename=$1 AND folder_slug IS NULL';
      const vals = folderSlug ? [filename, folderSlug] : [filename];
      const { rows } = await pool.query(`UPDATE ebook_files SET enabled=$3 WHERE ${cond} RETURNING *`, [...vals, enabled]);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else return res.status(400).json({ error: 'id or filename required' });

    res.json({ ok: true, filename: row.filename, enabled: row.enabled });
  } catch (e) {
    console.error('ebooks root enable error:', e);
    res.status(500).send('Failed to update file enabled');
  }
});

app.delete('/ebooks/files', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const id = req.query.id || (req.body && req.body.id);
    const filename = req.query.filename || (req.body && req.body.filename);
    const folderSlug = req.query.folderSlug || (req.body && req.body.folderSlug);

    let row = null;
    if (id) {
      const { rows } = await pool.query('SELECT * FROM ebook_files WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else if (filename) {
      const cond = folderSlug ? 'filename=$1 AND folder_slug=$2' : 'filename=$1 AND folder_slug IS NULL';
      const vals = folderSlug ? [filename, folderSlug] : [filename];
      const { rows } = await pool.query(`SELECT * FROM ebook_files WHERE ${cond}`, vals);
      if (!rows.length) return res.status(404).json({ error: 'file not found' });
      row = rows[0];
    } else return res.status(400).json({ error: 'id or filename required' });

    try { await cloudinary.uploader.destroy(row.public_id, { resource_type: 'raw' }); } catch (e) { console.warn('cloud delete failed', e.message); }
    await pool.query('DELETE FROM ebook_files WHERE id=$1', [row.id]);

    res.json({ ok: true, filename: row.filename });
  } catch (e) {
    console.error('ebooks root delete error:', e);
    res.status(500).send('Failed to delete file');
  }
});

// Reorder ebook files
async function reorderEbookFiles(folderSlug, targetIdOrName, direction, newIndex) {
  const cond = folderSlug ? 'folder_slug=$1' : 'folder_slug IS NULL';
  const vals = folderSlug ? [folderSlug] : [];
  const { rows } = await pool.query(`SELECT id, filename FROM ebook_files WHERE ${cond} ORDER BY order_index ASC, lower(filename) ASC`, vals);
  let list = rows.map(r => ({ id: r.id, name: r.filename }));
  let idx = list.findIndex(x => String(x.id) === String(targetIdOrName) || String(x.name) === String(targetIdOrName));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const item = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, item);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx >= 0 && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) {
    await pool.query('UPDATE ebook_files SET order_index=$1 WHERE id=$2', [i, list[i].id]);
  }
}

app.post('/ebooks/files/reorder', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const { id, filename, folderSlug, direction, newIndex } = req.body || {};
    const target = id || filename;
    if (!target) return res.status(400).json({ error: 'id or filename required' });
    await reorderEbookFiles(folderSlug || null, target, direction, typeof newIndex === 'number' ? newIndex : undefined);

    const cond = folderSlug ? 'folder_slug=$1' : 'folder_slug IS NULL';
    const vals = folderSlug ? [folderSlug] : [];
    const { rows } = await pool.query(`SELECT filename FROM ebook_files WHERE ${cond} ORDER BY order_index ASC, lower(filename) ASC`, vals);
    res.json({ ok: true, order: rows.map(r => r.filename) });
  } catch (e) {
    console.error('ebooks reorder error:', e);
    res.status(500).send('Failed to reorder');
  }
});

/* ===================== Analytics + Totals (DB-based) ===================== */
app.get('/totals', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable(); await ensureExpensesTable();
    const { rows: d } = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM donations WHERE approved = true');
    const { rows: e } = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE approved = true AND enabled = true');
    const totalDonation = Number(d[0].total || 0);
    const totalExpense = Number(e[0].total || 0);
    res.json({ totalDonation, totalExpense, balance: totalDonation - totalExpense });
  } catch (err) { console.error(err); res.status(500).send('Totals failed'); }
});

app.get('/analytics/summary', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable(); await ensureExpensesTable();
    const { rows: dsum } = await pool.query(`SELECT category, COALESCE(SUM(amount),0)::float AS total FROM donations WHERE approved=true GROUP BY category`);
    const { rows: esum } = await pool.query(`SELECT category, COALESCE(SUM(amount),0)::float AS total FROM expenses WHERE approved=true AND enabled=true GROUP BY category`);
    // simple merged summary by category
    const map = new Map();
    for (const r of dsum) {
      const k = (r.category || '').trim();
      if (!map.has(k)) map.set(k, { category: k, donationTotal: 0, expenseTotal: 0 });
      map.get(k).donationTotal += Number(r.total || 0);
    }
    for (const r of esum) {
      const k = (r.category || '').trim();
      if (!map.has(k)) map.set(k, { category: k, donationTotal: 0, expenseTotal: 0 });
      map.get(k).expenseTotal += Number(r.total || 0);
    }
    const out = Array.from(map.values()).map(x => ({ ...x, balance: (x.donationTotal - x.expenseTotal) }));
    res.json(out);
  } catch (e){ console.error('analytics summary error:', e); res.status(500).send('Analytics summary failed'); }
});

/* ===================== Debug endpoints ===================== */
app.get('/debug/donations', async (req, res) => {
  try {
    await ensureDonationsTable();
    const { rows: all } = await pool.query('SELECT id, amount, category, approved, receipt_code FROM donations');
    const approved = all.filter(d => d.approved);
    res.json({
      allCount: all.length,
      approvedCount: approved.length,
      approvedSample: approved.map(d => ({
        code: d.receipt_code, receiptCode: d.receipt_code,
        amount: Number(d.amount || 0), category: d.category, approved: d.approved
      })).slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});
app.get('/debug/expenses', async (req, res) => {
  try {
    await ensureExpensesTable();
    const { rows } = await pool.query('SELECT * FROM expenses ORDER BY id DESC LIMIT 10');
    res.json({ count: rows.length, sample: rows.map(rowToExpense) });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});

// Whoami
app.get('/admin/whoami', authRole(['admin','mainadmin']), (req, res) => {
  res.json(req.user);
});

/* ===================== Health + Start ===================== */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

async function start() {
  try {
    await ensureUsersTable();
    await ensureExpensesTable();
    await ensureDonationsTable();
    await ensureGalleryTables();
    await ensureEbooksTables();
    await ensureCategoriesTable();
    await seedAdmin();
    app.listen(PORT, HOST, () => {
      console.log(`Server listening on http://${HOST}:${PORT}`);
    });
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
}
start();/* === Injected: Analytics Admin (DB-based) === */
if (typeof ensureAnalyticsConfigTables !== 'function') {
  /* dedup: ensureAnalyticsConfigTables removed (use global version) */
}
if (typeof reorderAnalyticsFolders !== 'function') {
  /* dedup: reorderAnalyticsFolders removed (use global version) */ = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    let list = rows.map(r => r.id);
    let idx = list.indexOf(Number(folderId));
    if (idx === -1) return;
    if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
      const item = list.splice(idx,1)[0];
      list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, item);
    } else if (direction === 'up' && idx > 0) {
      [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
    } else if (direction === 'down' && idx < list.length - 1) {
      [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
    }
    for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
}
if (typeof reorderAnalyticsEvents !== 'function') {
  /* dedup: reorderAnalyticsEvents removed (use global version) */ = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    let list = rows.map(r => r.id);
    let idx = list.indexOf(Number(eventId));
    if (idx === -1) return;
    if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
      const item = list.splice(idx,1)[0];
      list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, item);
    } else if (direction === 'up' && idx > 0) {
      [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
    } else if (direction === 'down' && idx < list.length - 1) {
      [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
    }
    for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
}

// List folders with events
app.get('/analytics/admin/folders', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    await ensureAnalyticsConfigTables();
    const { rows: folders } = await pool.query('SELECT id, name, slug, enabled, order_index FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    const out = [];
    for (const f of folders) {
      const { rows: evs } = await pool.query(
        'SELECT id, name, enabled, show_donation_detail, show_expense_detail, order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
        [f.id]
      );
      out.push({
        id: f.id, name: f.name, slug: f.slug,
        enabled: f.enabled, orderIndex: f.order_index,
        events: evs.map(e=>({
          id: e.id, name: e.name, enabled: e.enabled,
          showDonationDetail: e.show_donation_detail,
          showExpenseDetail: e.show_expense_detail,
          orderIndex: e.order_index
        }))
      });
    }
    res.json(out);
  } catch (e){ console.error(e); res.status(500).send('Failed to load analytics folders'); }
});

// Create folder
app.post('/analytics/admin/folders', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    await ensureAnalyticsConfigTables();
    const { name, enabled } = req.body || {};
    const nm = String(name||'').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const en = !(enabled===false || enabled==='false' || enabled===0 || enabled==='0');
    const slug = slugify(nm);
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_folders');
    const { rows } = await pool.query(
      'INSERT INTO analytics_folders (name, slug, enabled, order_index) VALUES ($1,$2,$3,$4) RETURNING *',
      [nm, slug || null, en, Number(max[0].next||0)]
    );
    res.status(201).json(rows[0]);
  } catch (e){ 
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error: 'duplicate slug/name' });
    console.error(e); res.status(500).send('Create folder failed'); 
  }
});

// Update folder
app.put('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { name, enabled } = req.body || {};
    const fields=[]; const vals=[]; let i=1;
    if (typeof name==='string' && name.trim()) {
      const nm = name.trim(); fields.push(`name=$${i++}`); vals.push(nm);
      const sl = slugify(nm); if (sl) { fields.push(`slug=$${i++}`); vals.push(sl); }
    }
    if (enabled !== undefined) { fields.push(`enabled=$${i++}`); vals.push(!(enabled===false||enabled==='false'||enabled===0||enabled==='0')); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_folders SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e){ 
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error: 'duplicate slug/name' });
    console.error(e); res.status(500).send('Update folder failed'); 
  }
});

// Delete folder
app.delete('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e){ console.error(e); res.status(500).send('Delete folder failed'); }
});

// Reorder folders
app.post('/analytics/admin/folders/reorder', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    await reorderAnalyticsFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  } catch (e){ console.error(e); res.status(500).send('Reorder failed'); }
});

// Create event
app.post('/analytics/admin/events', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, name, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    const nm = String(name||'').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [folderId]);
    const { rows } = await pool.query(
      `INSERT INTO analytics_events (folder_id, name, enabled, show_donation_detail, show_expense_detail, order_index)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [folderId, nm, !(enabled===false||enabled==='false'||enabled===0||enabled==='0'),
       !(showDonationDetail===false||showDonationDetail==='false'),
       !(showExpenseDetail===false||showExpenseDetail==='false'),
       Number(max[0].next||0)]
    );
    res.status(201).json(rows[0]);
  } catch (e){ console.error(e); res.status(500).send('Create event failed'); }
});

// Update event
app.put('/analytics/admin/events/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { name, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const fields=[]; const vals=[]; let i=1;
    if (typeof name==='string' && name.trim()) { fields.push(`name=$${i++}`); vals.push(name.trim()); }
    if (enabled !== undefined) { fields.push(`enabled=$${i++}`); vals.push(!(enabled===false||enabled==='false'||enabled===0||enabled==='0')); }
    if (showDonationDetail !== undefined) { fields.push(`show_donation_detail=$${i++}`); vals.push(!(showDonationDetail===false||showDonationDetail==='false')); }
    if (showExpenseDetail !== undefined) { fields.push(`show_expense_detail=$${i++}`); vals.push(!(showExpenseDetail===false||showExpenseDetail==='false')); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e){ console.error(e); res.status(500).send('Update event failed'); }
});

// Delete event
app.delete('/analytics/admin/events/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e){ console.error(e); res.status(500).send('Delete event failed'); }
});

// Reorder events
app.post('/analytics/admin/events/reorder', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error: 'folderId and eventId required' });
    await reorderAnalyticsEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  } catch (e){ console.error(e); res.status(500).send('Reorder failed'); }
});
/* === End Injected: Analytics Admin (DB-based) === */



/* === ANALYTICS_ADMIN_ALIASES_BEGIN === */

/* Ensure tables (if not already present) */
if (typeof ensureAnalyticsConfigTables !== 'function') {
  /* dedup: ensureAnalyticsConfigTables removed (use global version) */
}
if (typeof reorderAnalyticsFolders !== 'function') {
  /* dedup: reorderAnalyticsFolders removed (use global version) */ = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    let list = rows.map(r => r.id);
    let idx = list.indexOf(Number(folderId));
    if (idx === -1) return;
    if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
      const it = list.splice(idx,1)[0];
      list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
    } else if (direction === 'up' && idx > 0) {
      [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
    } else if (direction === 'down' && idx < list.length - 1) {
      [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
    }
    for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
}
if (typeof reorderAnalyticsEvents !== 'function') {
  /* dedup: reorderAnalyticsEvents removed (use global version) */ = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    let list = rows.map(r => r.id);
    let idx = list.indexOf(Number(eventId));
    if (idx === -1) return;
    if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
      const it = list.splice(idx,1)[0];
      list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
    } else if (direction === 'up' && idx > 0) {
      [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
    } else if (direction === 'down' && idx < list.length - 1) {
      [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
    }
    for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
  }
}

/* Handlers */
async function listAnalyticsFoldersHandler(req,res){
  try {
    await ensureAnalyticsConfigTables();
    const { rows: folders } = await pool.query('SELECT id, name, slug, enabled, order_index FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    const out = [];
    for (const f of folders) {
      const { rows: evs } = await pool.query(
        'SELECT id, name, enabled, show_donation_detail, show_expense_detail, order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
        [f.id]
      );
      out.push({
        id: f.id, name: f.name, slug: f.slug,
        enabled: f.enabled, orderIndex: f.order_index,
        events: evs.map(e=>({
          id: e.id, name: e.name, enabled: e.enabled,
          showDonationDetail: e.show_donation_detail,
          showExpenseDetail: e.show_expense_detail,
          orderIndex: e.order_index
        }))
      });
    }
    res.json(out);
  } catch (e){ console.error('analytics folders err:', e); res.status(500).send('Failed to load analytics folders'); }
}
async function createFolderHandler(req,res){
  try{
    await ensureAnalyticsConfigTables();
    const { name, folderName, enabled } = req.body || {};
    const nm = String(folderName || name || '').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const en = !(enabled===false || enabled==='false' || enabled===0 || enabled==='0');
    const slugVal = slugify(nm);
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_folders');
    const { rows } = await pool.query(
      'INSERT INTO analytics_folders (name, slug, enabled, order_index) VALUES ($1,$2,$3,$4) RETURNING *',
      [nm, slugVal || null, en, Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  }catch(e){
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error: 'duplicate slug/name' });
    console.error('create folder err:', e); res.status(500).send('Create folder failed');
  }
}
async function updateFolderHandler(req,res){
  try{
    const { id } = req.params;
    const { name, newName, enabled } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn) { fields.push(`name=$${i++}`); vals.push(nmIn); const sl = slugify(nmIn); if (sl) { fields.push(`slug=$${i++}`); vals.push(sl); } }
    if (enabled !== undefined) { fields.push(`enabled=$${i++}`); vals.push(!(enabled===false||enabled==='false'||enabled===0||enabled==='0')); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_folders SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  }catch(e){
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error: 'duplicate slug/name' });
    console.error('update folder err:', e); res.status(500).send('Update folder failed');
  }
}
async function enableFolderHandler(req,res){
  try{
    const { id } = req.params;
    const enRaw = req.body?.enabled;
    const en = !(enRaw===false || enRaw==='false' || enRaw===0 || enRaw==='0');
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
}
async function deleteFolderHandler(req,res){
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
}
async function listEventsForFolderHandler(req,res){
  try{
    const { folderId } = req.params;
    const { rows } = await pool.query(
      'SELECT id, name, enabled, show_donation_detail, show_expense_detail, order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
      [folderId]
    );
    res.json(rows.map(e=>({
      id: e.id, name: e.name, enabled: e.enabled,
      showDonationDetail: e.show_donation_detail,
      showExpenseDetail: e.show_expense_detail,
      orderIndex: e.order_index
    })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
}
async function createEventHandler(req,res){
  try{
    const { folderId, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [folderId]);
    const { rows } = await pool.query(
      `INSERT INTO analytics_events (folder_id, name, enabled, show_donation_detail, show_expense_detail, order_index)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [folderId, nm, !(enabled===false||enabled==='false'||enabled===0||enabled==='0'),
       !(showDonationDetail===false||showDonationDetail==='false'),
       !(showExpenseDetail===false||showExpenseDetail==='false'),
       Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  }catch(e){ console.error('create event err:', e); res.status(500).send('Create event failed'); }
}
async function updateEventHandler(req,res){
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn) { fields.push(`name=$${i++}`); vals.push(nmIn); }
    if (enabled !== undefined) { fields.push(`enabled=$${i++}`); vals.push(!(enabled===false||enabled==='false'||enabled===0||enabled==='0')); }
    if (showDonationDetail !== undefined) { fields.push(`show_donation_detail=$${i++}`); vals.push(!(showDonationDetail===false||showDonationDetail==='false')); }
    if (showExpenseDetail !== undefined) { fields.push(`show_expense_detail=$${i++}`); vals.push(!(showExpenseDetail===false||showExpenseDetail==='false')); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update event err:', e); res.status(500).send('Update event failed'); }
}
async function enableEventHandler(req,res){
  try{
    const { id } = req.params;
    const enRaw = req.body?.enabled;
    const en = !(enRaw===false || enRaw==='false' || enRaw===0 || enRaw==='0');
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
}
async function deleteEventHandler(req,res){
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
}

/* Main routes + universal aliases */
app.get('/analytics/admin/folders', authRole(['admin','mainadmin']), listAnalyticsFoldersHandler);
app.get('/api/analytics/admin/folders', authRole(['admin','mainadmin']), listAnalyticsFoldersHandler);
app.get('/admin/analytics/folders', authRole(['admin','mainadmin']), listAnalyticsFoldersHandler);

app.post('/analytics/admin/folders', authRole(['admin','mainadmin']), createFolderHandler);
app.post('/analytics/admin/folders/create', authRole(['admin','mainadmin']), createFolderHandler);
app.post('/api/analytics/admin/folders', authRole(['admin','mainadmin']), createFolderHandler);

app.put('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), updateFolderHandler);
app.post('/analytics/admin/folders/:id/rename', authRole(['admin','mainadmin']), updateFolderHandler);
app.post('/analytics/admin/folders/:id/enable', authRole(['admin','mainadmin']), enableFolderHandler);

app.delete('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), deleteFolderHandler);

app.post('/analytics/admin/folders/reorder', authRole(['admin','mainadmin']), async (req,res)=>{
  try{
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    await reorderAnalyticsFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

app.get('/analytics/admin/folders/:folderId/events', authRole(['admin','mainadmin']), listEventsForFolderHandler);
app.get('/api/analytics/admin/folders/:folderId/events', authRole(['admin','mainadmin']), listEventsForFolderHandler);

app.post('/analytics/admin/events', authRole(['admin','mainadmin']), createEventHandler);
app.post('/analytics/admin/events/create', authRole(['admin','mainadmin']), createEventHandler);
app.post('/api/analytics/admin/events', authRole(['admin','mainadmin']), createEventHandler);

app.put('/analytics/admin/events/:id', authRole(['admin','mainadmin']), updateEventHandler);
app.post('/analytics/admin/events/:id/rename', authRole(['admin','mainadmin']), updateEventHandler);
app.post('/analytics/admin/events/:id/enable', authRole(['admin','mainadmin']), enableEventHandler);

app.delete('/analytics/admin/events/:id', authRole(['admin','mainadmin']), deleteEventHandler);
app.post('/analytics/admin/events/:id/delete', authRole(['admin','mainadmin']), deleteEventHandler);

/* Debug: check schema + counts */
app.get('/debug/analytics-admin/diag', async (req,res)=>{
  try{
    const f = await pool.query('SELECT COUNT(*)::int AS c FROM analytics_folders');
    const e = await pool.query('SELECT COUNT(*)::int AS c FROM analytics_events');
    const cf = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='analytics_folders' ORDER BY column_name");
    const ce = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='analytics_events' ORDER BY column_name");
    res.json({ ok:true, foldersCount:f.rows[0].c, eventsCount:e.rows[0].c, foldersColumns:cf.rows, eventsColumns:ce.rows });
  }catch(err){ res.status(500).json({ ok:false, error:String(err.message) }); }
});

/* === ANALYTICS_ADMIN_ALIASES_END === */



/* === ANALYTICS_ADMIN_DB_MOUNT_BEGIN === */
/* DB-based Manage Analytics on /analytics/admin */

/* dedup: ensureAnalyticsConfigTables removed (use global version) */

/* dedup: reorderAnalyticsFolders removed (use global version) */ = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(folderId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
}
/* dedup: reorderAnalyticsEvents removed (use global version) */ = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(eventId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
}

function normBool(x) { return !(x===false || x==='false' || x===0 || x==='0'); }
function safeSlug(s) {
  const raw = (String(s||'').toLowerCase().trim().normalize('NFKD').replace(/[^\w\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-')) || '';
  return raw || ('group-' + Date.now());
}

/* List folders (+events) */
app.get('/analytics/admin/folders', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    await ensureAnalyticsConfigTables();
    const { rows: folders } = await pool.query('SELECT id, name, slug, enabled, order_index FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    const out = [];
    for (const f of folders) {
      const { rows: evs } = await pool.query(
        'SELECT id, name, enabled, show_donation_detail, show_expense_detail, order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
        [f.id]
      );
      out.push({
        id: f.id, name: f.name, slug: f.slug,
        enabled: f.enabled, orderIndex: f.order_index,
        events: evs.map(e=>({
          id: e.id, name: e.name, enabled: e.enabled,
          showDonationDetail: e.show_donation_detail,
          showExpenseDetail: e.show_expense_detail,
          orderIndex: e.order_index
        }))
      });
    }
    res.json(out);
  } catch (e){ console.error('folders list err:', e); res.status(500).send('Failed to load analytics folders'); }
});

/* Create folder (auto-suffix slug if clash) */
app.post('/analytics/admin/folders', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    await ensureAnalyticsConfigTables();
    const { name, folderName, enabled } = req.body || {};
    const nm = String(folderName || name || '').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const en = normBool(enabled);
    let slug = safeSlug(nm);

    // auto-suffix if slug exists
    for (let i=2;i<100;i++) {
      const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 LIMIT 1', [slug]);
      if (!rows.length) break;
      slug = `${safeSlug(nm)}-${i}`;
    }

    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_folders');
    const { rows } = await pool.query(
      'INSERT INTO analytics_folders (name, slug, enabled, order_index) VALUES ($1,$2,$3,$4) RETURNING id,name,slug,enabled,order_index',
      [nm, slug, en, Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  } catch (e){
    // log full details for now
    console.error('create folder err:', e);
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error: 'constraint', code: e.code, constraint: e.constraint, detail: e.detail });
    res.status(500).json({ error: 'Create folder failed', code: e.code, detail: e.detail });
  }
});

/* Update folder */
app.put('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { name, newName, enabled } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn) { fields.push(`name=$${i++}`); vals.push(nmIn); let sl = safeSlug(nmIn);
      // auto-suffix
      for (let j=2;j<100;j++){ const {rows} = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 AND id<>$2 LIMIT 1',[sl,id]); if(!rows.length) break; sl=`${safeSlug(nmIn)}-${j}`; }
      fields.push(\`slug=$\${i++}\`); vals.push(sl);
    }
    if (enabled !== undefined) { fields.push(\`enabled=$\${i++}\`); vals.push(normBool(enabled)); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(\`UPDATE analytics_folders SET \${fields.join(', ')} WHERE id=$\${i} RETURNING *\`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e){ console.error('update folder err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update folder failed'); }
});

/* Enable/disable folder */
app.post('/analytics/admin/folders/:id/enable', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const en = normBool(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  } catch (e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
});

/* Delete folder */
app.delete('/analytics/admin/folders/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true });
  } catch (e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
});

/* Reorder folders */
app.post('/analytics/admin/folders/reorder', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    await reorderAnalyticsFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  } catch (e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

/* List events in a folder */
app.get('/analytics/admin/folders/:folderId/events', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId } = req.params;
    const { rows } = await pool.query(
      'SELECT id, name, enabled, show_donation_detail, show_expense_detail, order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
      [folderId]
    );
    res.json(rows.map(e=>({
      id: e.id, name: e.name, enabled: e.enabled,
      showDonationDetail: e.show_donation_detail, showExpenseDetail: e.show_expense_detail, orderIndex: e.order_index
    })));
  } catch (e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});

/* Create event */
app.post('/analytics/admin/events', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [folderId]);
    const { rows } = await pool.query(
      \`INSERT INTO analytics_events (folder_id, name, enabled, show_donation_detail, show_expense_detail, order_index)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *\`,
      [folderId, nm, normBool(enabled), normBool(showDonationDetail), normBool(showExpenseDetail), Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  } catch (e){ console.error('create event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Create event failed'); }
});

/* Update event */
app.put('/analytics/admin/events/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn) { fields.push(\`name=$\${i++}\`); vals.push(nmIn); }
    if (enabled !== undefined) { fields.push(\`enabled=$\${i++}\`); vals.push(normBool(enabled)); }
    if (showDonationDetail !== undefined) { fields.push(\`show_donation_detail=$\${i++}\`); vals.push(normBool(showDonationDetail)); }
    if (showExpenseDetail !== undefined) { fields.push(\`show_expense_detail=$\${i++}\`); vals.push(normBool(showExpenseDetail)); }
    if (!fields.length) return res.status(400).json({ error: 'No changes' });
    vals.push(id);
    const { rows } = await pool.query(\`UPDATE analytics_events SET \${fields.join(', ')} WHERE id=$\${i} RETURNING *\`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e){ console.error('update event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update event failed'); }
});

/* Enable/disable event */
app.post('/analytics/admin/events/:id/enable', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const en = normBool(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  } catch (e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
});

/* Delete event */
app.delete('/analytics/admin/events/:id', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok:true });
  } catch (e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
});

/* Reorder events */
app.post('/analytics/admin/events/reorder', authRole(['admin','mainadmin']), async (req,res)=>{
  try {
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error: 'folderId and eventId required' });
    await reorderAnalyticsEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  } catch (e){ console.error('reorder event err:', e); res.status(500).send('Reorder failed'); }
});
/* === ANALYTICS_ADMIN_DB_MOUNT_END === */


