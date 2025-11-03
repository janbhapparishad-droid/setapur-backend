/* === SETAPUR BACKEND SERVER - PRODUCTION READY === */
/* === All critical fixes applied + all endpoints included === */

// ============================================================================
// LINE 1: LOAD ENVIRONMENT VARIABLES (CRITICAL FIX)
// ============================================================================
require('dotenv').config();

// ============================================================================
// VALIDATE REQUIRED ENVIRONMENT VARIABLES AT STARTUP
// ============================================================================
const requiredEnvVars = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ FATAL ERROR: Missing required environment variables:');
  missingEnvVars.forEach(v => console.error(\`   - \${v}\`));
  console.error('\nPlease ensure all required env vars are set in your .env file');
  process.exit(1);
}

console.log('✓ All required environment variables are set');

// ============================================================================
// IMPORTS
// ============================================================================
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

// ============================================================================
// DATABASE CONNECTION (WITH FIX: SSL properly configured)
// ============================================================================
const useSSL = !!(
  (process.env.DATABASE_URL && /sslmode=require|neon|render|amazonaws|\\.neon\\.tech/i.test(process.env.DATABASE_URL))
  || process.env.PGSSL === '1'
  || process.env.PGSSLMODE === 'require'
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// FIXED: Add error handler for connection pool
pool.on('error', (err) => {
  console.error('❌ Unexpected database pool error:', err);
});

console.log('✓ Database pool created');

// ============================================================================
// CLOUDINARY SETUP
// ============================================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('✓ Cloudinary configured');

// ============================================================================
// JWT SECRET (FIXED: No weak default fallback)
// ============================================================================
const SECRET_KEY = process.env.JWT_SECRET;
if (!SECRET_KEY) {
  console.error('❌ FATAL ERROR: JWT_SECRET environment variable is not set!');
  process.exit(1);
}

console.log('✓ JWT Secret loaded (length:', SECRET_KEY.length, 'chars)');

// ============================================================================
// PORT AND HOST (FIXED: Now properly defined)
// ============================================================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

console.log(\`✓ Server will listen on http://\${HOST}:\${PORT}\`);

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================
const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

// Static files
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

console.log('✓ Express app initialized');

// ============================================================================
// AUTH HELPERS
// ============================================================================
function normRole(r) { 
  return String(r || '').trim().toLowerCase().replace(/[\\s_-]+/g, ''); 
}

function authOptional(req, res, next) {
  try {
    const header = req.headers['authorization'];
    if (header) {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
      const verified = jwt.verify(token, SECRET_KEY);
      verified.role = normRole(verified.role);
      verified.username = String(verified.username || '');
      req.user = verified;
    }
  } catch (e) { 
    console.log('Optional auth failed:', e.message);
  }
  next();
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

      if (!allowed.includes(req.user.role) && !allowed.includes('any')) return res.status(403).send('Forbidden');

      try {
        const users = await getUsers();
        const u = users.find(u => String(u.username) === req.user.username);
        if (u && (u.banned === true || u.banned === 'true' || u.banned === 1 || u.banned === '1')) {
          return res.status(403).send('User banned');
        }
      } catch (e) {
        console.log('User ban check failed:', e.message);
      }

      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).send('Token expired');
      return res.status(400).send('Invalid Token');
    }
  };
}

// ============================================================================
// ANALYTICS HELPERS
// ============================================================================
global.AnalyticsAdmin = global.AnalyticsAdmin || {};
if (!global.AnalyticsAdmin.ensure) {
  global.AnalyticsAdmin.ensure = async function ensure() {
    await pool.query(\`
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
    \`);
  };
}

if (!global.AnalyticsAdmin.reorderFolders) {
  global.AnalyticsAdmin.reorderFolders = async function reorderFolders(folderId, direction, newIndex) {
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
    for (let i=0;i<list.length;i++) {
      await pool.query('UPDATE analytics_folders SET order_index=\$1 WHERE id=\$2', [i, list[i]]);
    }
  };
}

if (!global.AnalyticsAdmin.reorderEvents) {
  global.AnalyticsAdmin.reorderEvents = async function reorderEvents(folderId, eventId, direction, newIndex) {
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=\$1 ORDER BY order_index ASC, id ASC', [folderId]);
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
    for (let i=0;i<list.length;i++) {
      await pool.query('UPDATE analytics_events SET order_index=\$1 WHERE id=\$2', [i, list[i]]);
    }
  };
}

// ============================================================================
// COMMON HELPERS
// ============================================================================
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s+/g, '-')
    .replace(/-+/g, '-');
}

function pushNotification(_username, _notif) {
  // Placeholder for notification system
}

const SENSITIVE_KEYS = ['screenshotUrl', 'screenshotPath', 'paymentScreenshot', 'screenshot', 'cashReceiverName', 'receiverName', 'receivedBy'];

function isApproved(d) { 
  return d && (d.approved === true || d.approved === 'true' || d.approved === 1 || d.approved === '1'); 
}

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

function pgNum(x) { 
  const n = Number(x); 
  return Number.isFinite(n) ? n : 0; 
}

// ============================================================================
// USERS (PostgreSQL)
// ============================================================================
async function ensureUsersTable() {
  await pool.query(\`
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
  \`);
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
  const { rows } = await pool.query(\`
    SELECT id, username, password_hash, role, banned, name, full_name, display_name, logged_in, created_at
    FROM users ORDER BY id ASC
  \`);
  return rows.map(rowToUser);
}

async function saveUsers(users) {
  await ensureUsersTable();
  if (!Array.isArray(users)) return;
  for (const u of users) {
    let passwordHash = u.passwordHash || null;
    if (u.password && String(u.password).trim()) {
      // FIXED: Use await bcrypt.hash instead of bcrypt.hashSync (non-blocking)
      passwordHash = await bcrypt.hash(u.password, 10);
      delete u.password;
    }
    await pool.query(
      \`INSERT INTO users (username, password_hash, role, banned, name, full_name, display_name, logged_in)
       VALUES (\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         role = EXCLUDED.role,
         banned = EXCLUDED.banned,
         name = EXCLUDED.name,
         full_name = EXCLUDED.full_name,
         display_name = EXCLUDED.display_name,
         logged_in = EXCLUDED.logged_in\`,
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
      console.log(\`✓ Seeded admin user '\${username}'\`);
    } else if (shouldReset) {
      const next = users.slice();
      next[idx].password = password;
      next[idx].role = role;
      next[idx].banned = false;
      await saveUsers(next);
      console.log(\`✓ Reset admin user '\${username}'\`);
    } else {
      console.log(\`✓ Admin user '\${username}' already exists\`);
    }
  } catch (e) {
    console.warn('Admin seed skipped:', e.message);
  }
}

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body || {};
    const users = await getUsers();
    const user = users.find((u) => u.username === username);

    if (!user) return res.status(400).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'User banned' });

    const validPass = await bcrypt.compare(password, user.passwordHash);
    if (!validPass) return res.status(400).json({ error: 'Invalid password' });

    user.loggedIn = deviceId; 
    await saveUsers(users);

    const cleanRole = normRole(user.role || 'user');
    const token = jwt.sign({ id: user.id, username: user.username, role: cleanRole }, SECRET_KEY, { expiresIn: '8h' });
    res.json({ token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================================
// USER MANAGEMENT
// ============================================================================
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
  try {
    const users = await getUsers();
    res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, banned: !!u.banned })));
  } catch (e) {
    console.error('list users error:', e);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ============================================================================
// DB SCHEMA ENSURES - ALL TABLES
// ============================================================================
async function ensureCategoriesTable() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  \`);
}

async function ensureExpensesTable() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      paid_to TEXT,
      date TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  \`);
  await pool.query(\`
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
  \`);
}

async function ensureDonationsTable() {
  await pool.query(\`
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
  \`);
  await pool.query(\`
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
  \`);
}

async function ensureGalleryTables() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS gallery_folders (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE
    );
  \`);
  await pool.query(\`
    ALTER TABLE gallery_folders
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cover_public_id TEXT,
      ADD COLUMN IF NOT EXISTS cover_url TEXT,
      ADD COLUMN IF NOT EXISTS icon_public_id TEXT,
      ADD COLUMN IF NOT EXISTS icon_key TEXT;
  \`);
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS gallery_images (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES gallery_folders(slug) ON DELETE CASCADE,
      public_id TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL
    );
  \`);
  await pool.query(\`
    ALTER TABLE gallery_images
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bytes INT,
      ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_gallery_images_folder ON gallery_images (folder_slug);
    CREATE INDEX IF NOT EXISTS idx_gallery_images_enabled ON gallery_images (enabled);
  \`);
}

async function ensureEbooksTables() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS ebook_folders (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE
    );
  \`);
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS ebook_files (
      id SERIAL PRIMARY KEY,
      folder_slug TEXT REFERENCES ebook_folders(slug) ON DELETE CASCADE,
      public_id TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL
    );
  \`);
  await pool.query(\`
    ALTER TABLE ebook_files
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bytes INT,
      ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_ebook_files_folder ON ebook_files (folder_slug);
    CREATE INDEX IF NOT EXISTS idx_ebook_files_enabled ON ebook_files (enabled);
  \`);
}

// ============================================================================
// CATEGORIES ENDPOINTS
// ============================================================================
function rowToCategory(r) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    createdAt: r.created_at,
  };
}

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
    res.json(rows.map(rowToCategory));
  } catch (e) {
    console.error('categories list error:', e);
    res.status(500).send('Failed to list categories');
  }
};

const createCategoryHandler = async (req, res) => {
  try {
    await ensureCategoriesTable();
    const nm = (req.body?.name ?? '').toString().trim();
    if (!nm) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO categories(name, enabled) VALUES (\$1, TRUE) ON CONFLICT (name) DO NOTHING RETURNING id, name, enabled, created_at',
      [nm]
    );
    if (!rows.length) return res.status(409).json({ error: 'category already exists' });
    return res.status(201).json(rowToCategory(rows[0]));
  } catch (e) {
    console.error('categories create error:', e);
    return res.status(500).json({ error: 'Create failed' });
  }
};

app.get('/api/categories', authRole(['user','admin','mainadmin']), listCategoriesHandler);
app.post('/api/categories', authRole(['admin','mainadmin']), createCategoryHandler);
app.get('/api/categories/list', authRole(['user','admin','mainadmin']), listCategoriesHandler);
app.post('/api/admin/categories', authRole(['admin','mainadmin']), createCategoryHandler);
app.get('/api/categories/enabled', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureCategoriesTable();
    const { rows } = await pool.query('SELECT id, name, enabled, created_at FROM categories WHERE enabled = true ORDER BY lower(name) ASC');
    res.json(rows.map(rowToCategory));
  } catch (e) {
    console.error('categories enabled-list error:', e);
    res.status(500).send('Failed to list categories');
  }
});

// ============================================================================
// EXPENSES ENDPOINTS (WITH FIX: No incorrect category toggle)
// ============================================================================
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

    const values = [];
    let where = [];
    if (q) { values.push(q); where.push('lower(category) = \$' + values.length); }

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
      let sql = \`SELECT * FROM expenses WHERE approved = true AND enabled = true\`;
      if (where.length) sql += ' AND ' + where.join(' AND ');
      const { rows: approvedEnabled } = await pool.query(sql, values);
      let list = approvedEnabled.map(rowToExpense);
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
      \`INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, submitted_by, submitted_by_id)
       VALUES (\$1,\$2,\$3,\$4,\$5,\$6,\$6,true,false,'pending',\$7,\$8) RETURNING *\`,
      [amt, cat, (description||'').trim(), (paidTo||'').trim(), date ? new Date(date) : now, now, req.user?.username || null, req.user?.id || null]
    );
    res.status(201).json({ message: 'Expense submitted (pending)', expense: rowToExpense(rows[0]) });
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
      \`INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, submitted_by, submitted_by_id, approved_by, approved_by_id, approved_at)
       VALUES (\$1,\$2,\$3,\$4,\$5,\$6,\$6,true,\$7,\$8,\$9,\$10,\$11,\$12,\$13) RETURNING *\`,
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
      fields.push(\`amount = \$\${idx++}\`); vals.push(amt);
    }
    if (typeof body.category === 'string') { fields.push(\`category = \$\${idx++}\`); vals.push(body.category.trim()); }
    if (typeof body.description === 'string') { fields.push(\`description = \$\${idx++}\`); vals.push(body.description.trim()); }
    if (typeof body.paidTo === 'string') { fields.push(\`paid_to = \$\${idx++}\`); vals.push(body.paidTo.trim()); }
    if (body.date) { fields.push(\`date = \$\${idx++}\`); vals.push(new Date(body.date)); }
    if (body.enabled !== undefined) { fields.push(\`enabled = \$\${idx++}\`); vals.push(!(body.enabled === false || body.enabled === 'false')); }

    if (!fields.length) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    fields.push(\`updated_at = now()\`);
    vals.push(id);
    const sql = \`UPDATE expenses SET \${fields.join(', ')} WHERE id=\$\${idx} RETURNING *\`;
    const { rows } = await pool.query(sql, vals);
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
    const { rows } = await pool.query(
      \`UPDATE expenses SET enabled=\$1, updated_at=now() WHERE id=\$2 RETURNING *\`, [enabled, id]
    );
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
      \`UPDATE expenses SET approved=\$1, status=\$2, approved_by=\$3, approved_by_id=\$4, approved_at=\$5, updated_at=now()
       WHERE id=\$6 RETURNING *\`,
      [approve, approve ? 'approved' : 'pending', req.user.username, req.user.id, approve ? new Date() : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: \`Expense \${approve ? 'approved' : 'set to pending'}\`, expense: rowToExpense(rows[0]) });
  } catch (e) {
    console.error('approve expense error:', e);
    res.status(500).send('Approval failed');
  }
});

app.delete('/api/expenses/:id', authRole(['admin','mainadmin']), async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const { rows } = await pool.query('DELETE FROM expenses WHERE id=\$1 RETURNING *', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted', expense: rowToExpense(rows[0]) });
  } catch (err) {
    console.error('delete expense error:', err);
    res.status(500).send('Delete expense failed');
  }
});

// ============================================================================
// DONATIONS ENDPOINTS
// ============================================================================
const donationScreenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'setapur/screenshots', allowed_formats: ['jpg','jpeg','png','webp','gif'], resource_type: 'image' },
});
const uploadDonation = multer({ storage: donationScreenshotStorage, limits: { fileSize: 20 * 1024 * 1024 } });

async function receiptCodeExists(code) {
  const { rows } = await pool.query(
    'SELECT 1 FROM donations WHERE upper(receipt_code) = upper(\$1) LIMIT 1', [code]
  );
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
      \`INSERT INTO donations
       (donor_user_id, donor_username, donor_name, amount, payment_method, category, cash_receiver_name,
        approved, status, created_at, updated_at, screenshot_public_id, screenshot_url, receipt_code)
       VALUES (\$1,\$2,\$3,\$4,\$5,\$6,\$7,false,'pending',now(),now(),\$8,\$9,\$10)
       RETURNING *\`,
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

app.post('/api/donations/create',
  authRole(['user','admin','mainadmin']),
  uploadDonation.single('screenshot'),
  createDonationHandler
);

app.get('/myaccount/receipts', authRole(['user','admin','mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const username = req.user.username;
  const { rows } = await pool.query(
    \`SELECT * FROM donations WHERE approved = true AND (
      donor_username = \$1 OR donor_name = \$1
    ) ORDER BY created_at DESC\`, [username]
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
      sql += \` WHERE lower(coalesce(donor_name,'')) ILIKE lower(\$1)
            OR lower(coalesce(donor_username,'')) ILIKE lower(\$1)
            OR lower(coalesce(receipt_code,'')) ILIKE lower(\$1)
            OR lower(coalesce(category,'')) ILIKE lower(\$1)\`;
      vals = [\`%\${q}%\`];
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(sql, vals);
    return res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
  }

  // mine
  let where = \` WHERE (donor_username = \$1 OR donor_name = \$1)\`;
  const vals = [req.user.username];
  if (status === 'pending') where += ' AND approved = false';
  else if (status === 'approved') where += ' AND approved = true';
  if (q) {
    where += \` AND (lower(coalesce(donor_name,'')) ILIKE lower(\$2)
                OR lower(coalesce(receipt_code,'')) ILIKE lower(\$2)
                OR lower(coalesce(category,'')) ILIKE lower(\$2))\`;
    vals.push(\`%\${q}%\`);
  }
  const sql = 'SELECT * FROM donations' + where + ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, vals);
  res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
});

app.get('/api/donations/all-donations', authRole(['admin', 'mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const role = req.user.role;
  const q = (req.query.q || req.query.search || '').toString().trim();
  let sql = 'SELECT * FROM donations';
  let vals = [];
  if (q) {
    sql += \` WHERE lower(coalesce(donor_name,'')) ILIKE lower(\$1)
          OR lower(coalesce(donor_username,'')) ILIKE lower(\$1)
          OR lower(coalesce(receipt_code,'')) ILIKE lower(\$1)
          OR lower(coalesce(category,'')) ILIKE lower(\$1)\`;
    vals = [\`%\${q}%\`];
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, vals);
  res.json(rows.map(r => redactDonationForRole(rowToDonation(r), role)));
});

app.get('/admin/donations/pending', authRole(['admin', 'mainadmin']), async (req, res) => {
  await ensureDonationsTable();
  const { rows } = await pool.query('SELECT * FROM donations WHERE approved=false ORDER BY created_at DESC');
  res.json(rows.map(rowToDonation));
});

app.post('/admin/donations/:id/approve', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureDonationsTable();
    const { id } = req.params;
    const { rows: curRows } = await pool.query('SELECT * FROM donations WHERE id=\$1', [id]);
    if (!curRows.length) return res.status(404).json({ error: 'Donation not found' });
    let d = curRows[0];

    let rc = (d.receipt_code || '').toUpperCase();
    const valid = rc.length === 6 && /^[A-Z0-9]{6}\$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
    if (!valid) rc = await generateUniqueReceiptCodeDB();

    let approvedByName = req.user.username;
    try {
      const users = await getUsers();
      const approver = users.find(u => u.username === req.user.username);
      approvedByName = approver?.name || approver?.fullName || approver?.displayName || approvedByName;
    } catch {}

    const { rows: upd } = await pool.query(
      \`UPDATE donations SET
         approved=true, status='approved',
         approved_by=\$1, approved_by_id=\$2, approved_by_role=\$3, approved_by_name=\$4, approved_at=now(),
         receipt_code=\$5, updated_at=now()
       WHERE id=\$6
       RETURNING *\`,
      [req.user.username, req.user.id, req.user.role, approvedByName, rc, id]
    );
    res.json({ message: 'Donation approved', donation: rowToDonation(upd[0]) });
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
      \`UPDATE donations SET approved=false, status='pending',
       approved_by=NULL, approved_by_id=NULL, approved_by_role=NULL, approved_by_name=NULL, approved_at=NULL, updated_at=now()
       WHERE id=\$1 RETURNING *\`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    res.json({ message: 'Donation set to pending', donation: rowToDonation(rows[0]) });
  } catch (err) {
    console.error('admin disapprove error:', err);
    return res.status(500).send('Disapprove failed');
  }
});

// ============================================================================
// GALLERY ENDPOINTS
// ============================================================================
app.get('/gallery/folders', authRole(['user', 'admin', 'mainadmin']), async (req, res) => {
  try {
    await ensureGalleryTables();
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    let sql = 'SELECT slug, name, enabled, order_index, cover_url, icon_key FROM gallery_folders';
    if (!isAdmin) sql += ' WHERE enabled = true';
    sql += ' ORDER BY order_index ASC, lower(name) ASC';
    const { rows } = await pool.query(sql);
    const foldersOut = rows.map(r => ({
      name: r.name,
      slug: r.slug,
      coverUrl: r.cover_url || null,
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

// ============================================================================
// EBOOKS ENDPOINTS
// ============================================================================
app.get('/ebooks/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  try {
    await ensureEbooksTables();
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    let sql = 'SELECT slug, name, enabled FROM ebook_folders';
    if (!isAdmin) sql += ' WHERE enabled = true';
    sql += ' ORDER BY lower(name) ASC';
    const { rows } = await pool.query(sql);
    const out = [];
    for (const f of rows) {
      const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM ebook_files WHERE folder_slug=\$1', [f.slug]);
      out.push({
        name: f.name,
        slug: f.slug,
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

// ============================================================================
// DEBUG ENDPOINTS (FIXED: Only one /debug/version)
// ============================================================================
app.get('/debug/version', (req, res) => {
  try {
    const txt = fs.readFileSync(__filename, 'utf8');
    const hash = crypto.createHash('sha1').update(txt).digest('hex');
    res.json({ 
      file: __filename, 
      lines: txt.split('\n').length, 
      sha1: hash, 
      ts: Date.now(),
      node: process.version,
      port: PORT
    });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// ============================================================================
// STARTUP FUNCTION
// ============================================================================
async function start() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('SETAPUR BACKEND SERVER STARTING');
    console.log('='.repeat(80) + '\n');

    // Initialize all database tables
    await ensureUsersTable();
    await ensureCategoriesTable();
    await ensureExpensesTable();
    await ensureDonationsTable();
    await ensureGalleryTables();
    await ensureEbooksTables();
    await seedAdmin();

    app.listen(PORT, HOST, () => {
      console.log(\`\n✓ Server listening on http://\${HOST}:\${PORT}\n\`);
      console.log('='.repeat(80));
    });
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
process.on('SIGTERM', () => {
  console.log('\n✓ SIGTERM received, shutting down gracefully...');
  pool.end(() => {
    console.log('✓ Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n✓ SIGINT received, shutting down gracefully...');
  pool.end(() => {
    console.log('✓ Database pool closed');
    process.exit(0);
  });
});

// ============================================================================
// START SERVER
// ============================================================================
start();
