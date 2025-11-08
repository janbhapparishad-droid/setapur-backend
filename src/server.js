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
const PORT = parseInt(process.env.PORT || '10000', 10);
const HOST = '0.0.0.0';

/* ===================== Middleware Setup ===================== */
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request Logger
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

// Static files (fallback)
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

/* ===================== Database & Cloud Config ===================== */
const useSSL = !!(
  (process.env.DATABASE_URL && /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(process.env.DATABASE_URL))
  || process.env.PGSSL === '1'
  || process.env.PGSSLMODE === 'require'
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ===================== Auth Helpers ===================== */
const SECRET_KEY = process.env.JWT_SECRET || 'your_secret_key_here';

function normRole(r) { return String(r || '').trim().toLowerCase().replace(/[\s_-]+/g, ''); }
function toBool(x) { return x === true || x === 'true' || x === 1 || x === '1'; }
function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-'); }
function generate6CharAlnumMix() {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', DIGITS = '0123456789', ALNUM = ALPHA + DIGITS;
  const arr = [ALPHA[crypto.randomInt(ALPHA.length)], DIGITS[crypto.randomInt(DIGITS.length)]];
  for (let i = 0; i < 4; i++) arr.push(ALNUM[crypto.randomInt(ALNUM.length)]);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}
function pushNotification() {} // Placeholder

function authOptional(req, res, next) {
  try {
    const header = req.headers['authorization'];
    if (header) {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
      const verified = jwt.verify(token, SECRET_KEY);
      req.user = { ...verified, role: normRole(verified.role), username: String(verified.username || '') };
    }
  } catch (_) {}
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
      req.user = { ...verified, role: normRole(verified.role), username: String(verified.username || '') };
      if (!allowed.includes(req.user.role) && !allowed.includes('any')) return res.status(403).send('Forbidden');
      // Check ban
      try {
        const { rows } = await pool.query('SELECT banned FROM users WHERE id=$1', [req.user.id]);
        if (rows.length && rows[0].banned) return res.status(403).send('User banned');
      } catch (_) {}
      next();
    } catch (err) {
      return res.status(err.name === 'TokenExpiredError' ? 401 : 400).send(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid Token');
    }
  };
}

/* ===================== DB Init ===================== */
async function ensureAllTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', banned BOOLEAN NOT NULL DEFAULT FALSE, name TEXT, full_name TEXT, display_name TEXT, logged_in TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, amount NUMERIC NOT NULL, category TEXT NOT NULL, description TEXT, paid_to TEXT, date TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(), ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE, ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending', ADD COLUMN IF NOT EXISTS submitted_by TEXT, ADD COLUMN IF NOT EXISTS submitted_by_id INT, ADD COLUMN IF NOT EXISTS approved_by TEXT, ADD COLUMN IF NOT EXISTS approved_by_id INT, ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS donations (id SERIAL PRIMARY KEY, donor_user_id INT, donor_username TEXT, donor_name TEXT, amount NUMERIC NOT NULL, payment_method TEXT NOT NULL, category TEXT NOT NULL, cash_receiver_name TEXT, approved BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'pending', screenshot_public_id TEXT, screenshot_url TEXT, receipt_code TEXT UNIQUE, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`ALTER TABLE donations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(), ADD COLUMN IF NOT EXISTS approved_by TEXT, ADD COLUMN IF NOT EXISTS approved_by_id INT, ADD COLUMN IF NOT EXISTS approved_by_role TEXT, ADD COLUMN IF NOT EXISTS approved_by_name TEXT, ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS gallery_folders (slug TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, order_index INT DEFAULT 0, cover_public_id TEXT, cover_url TEXT, icon_public_id TEXT, icon_key TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS gallery_images (id SERIAL PRIMARY KEY, folder_slug TEXT REFERENCES gallery_folders(slug) ON DELETE CASCADE, public_id TEXT UNIQUE NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, order_index INT DEFAULT 0, bytes INT, uploaded_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ebook_folders (slug TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ebook_files (id SERIAL PRIMARY KEY, folder_slug TEXT REFERENCES ebook_folders(slug) ON DELETE CASCADE, public_id TEXT UNIQUE NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, order_index INT DEFAULT 0, bytes INT, uploaded_at TIMESTAMPTZ DEFAULT now())`);
  
  // Fix Category Defaults
  try { await pool.query('ALTER TABLE categories ALTER COLUMN enabled SET DEFAULT TRUE'); await pool.query('UPDATE categories SET enabled = TRUE WHERE enabled IS NULL'); } catch (e) {}
  console.log('DB: Tables ensured.');
}

async function seedAdmin() {
  try {
    const u = process.env.INIT_ADMIN_USERNAME || 'admin', p = process.env.INIT_ADMIN_PASSWORD || 'Admin@123';
    const { rows } = await pool.query('SELECT id FROM users WHERE username=$1', [u]);
    if (!rows.length) {
      await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, "mainadmin")', [u, bcrypt.hashSync(p, 10)]);
      console.log(`Admin '${u}' seeded.`);
    } else if (String(process.env.INIT_ADMIN_RESET).toLowerCase() === 'true') {
      await pool.query('UPDATE users SET password_hash=$1, role="mainadmin", banned=false WHERE username=$2', [bcrypt.hashSync(p, 10), u]);
      console.log(`Admin '${u}' reset.`);
    }
  } catch (e) { console.warn('Admin seed skipped:', e.message); }
}

/* ===================== Routes: Auth & Users ===================== */
app.post('/auth/login', async (req, res) => {
  const { username, password, deviceId } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (!rows.length) return res.status(400).send('User not found');
  const user = rows[0];
  if (user.banned) return res.status(403).send('User banned');
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(400).send('Invalid password');
  await pool.query('UPDATE users SET logged_in=$1 WHERE id=$2', [deviceId, user.id]);
  res.json({ token: jwt.sign({ id: user.id, username: user.username, role: normRole(user.role) }, SECRET_KEY, { expiresIn: '8h' }) });
});

app.get('/admin/users', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, banned, created_at FROM users ORDER BY id ASC');
  res.json(rows.map(u => ({ ...u, banned: !!u.banned })));
});

app.post(['/admin/users', '/admin/create-user'], authRole(['admin','mainadmin']), async (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username/password required' });
    const { rows } = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role', [username, bcrypt.hashSync(password, 10), role]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'Username exists' : 'Create failed' }); }
});

async function handleUserBan(req, res) {
  const idOrUser = req.params.id || req.body.id || req.body.userId || req.body.username;
  if (!idOrUser) return res.status(400).json({ error: 'Target required' });
  const targetBan = req.body.banned ?? req.query.banned ?? req.body.ban ?? req.query.ban;
  const isId = /^\d+$/.test(idOrUser), where = isId ? 'id=$1' : 'username=$1', val = isId ? Number(idOrUser) : idOrUser;
  const sql = targetBan === undefined ? `UPDATE users SET banned = NOT COALESCE(banned, false) WHERE ${where} RETURNING id, username, role, banned` : `UPDATE users SET banned=$2 WHERE ${where} RETURNING id, username, role, banned`;
  const params = targetBan === undefined ? [val] : [val, toBool(targetBan)];
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: rows[0] });
}
const BAN_ROLES = ['admin','mainadmin'];
app.post(['/admin/users/:id/ban', '/api/admin/users/:id/ban', '/admin/users/ban', '/admin/ban-user'], authRole(BAN_ROLES), handleUserBan);
app.patch('/admin/users/:id', authRole(BAN_ROLES), handleUserBan);

/* ===================== Routes: Categories ===================== */
app.get(['/api/categories', '/api/categories/list', '/public/categories', '/api/categories/enabled'], async (req, res) => {
  try {
    // Simplified auth check for public route vs protected routes
    if (!req.path.startsWith('/public')) { await new Promise((resolve, reject) => authRole(['user','admin','mainadmin'])(req, res, (err) => err ? reject(err) : resolve())); }
    const isAdmin = req.user && ['admin','mainadmin'].includes(req.user.role);
    const onlyEnabled = req.path.includes('/enabled') || req.path.includes('/public') || (!isAdmin && !toBool(req.query.includeDisabled));
    const { rows } = await pool.query(`SELECT id, name, enabled, created_at FROM categories ${onlyEnabled ? 'WHERE enabled=true' : ''} ORDER BY lower(name) ASC`);
    res.json(rows);
  } catch (e) { res.status(500).send('List failed'); }
});

app.post(['/api/categories', '/admin/categories/create'], authRole(['admin','mainadmin']), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query('INSERT INTO categories(name, enabled) VALUES ($1, TRUE) ON CONFLICT (name) DO NOTHING RETURNING *', [name]);
    if (!rows.length) return res.status(409).json({ error: 'Category exists' });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).send('Create failed'); }
});

async function updateCategory(req, res) {
  const id = req.params.id || req.body.id;
  if (!id) return res.status(400).json({ error: 'ID required' });
  const name = req.body.name ?? req.body.newName, enabled = req.body.enabled;
  if (name === undefined && enabled === undefined) { // Toggle if no fields
    const { rows } = await pool.query('UPDATE categories SET enabled = NOT COALESCE(enabled, TRUE) WHERE id=$1 RETURNING *', [id]);
    return rows.length ? res.json({ ok: true, toggled: true, category: rows[0] }) : res.status(404).json({ error: 'Not found' });
  }
  const fields = [], vals = [id]; let idx = 2;
  if (name !== undefined && String(name).trim()) { fields.push(`name=$${idx++}`); vals.push(String(name).trim()); }
  if (enabled !== undefined) { fields.push(`enabled=$${idx++}`); vals.push(toBool(enabled)); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    const { rows } = await pool.query(`UPDATE categories SET ${fields.join(', ')} WHERE id=$1 RETURNING *`, vals);
    rows.length ? res.json({ ok: true, category: rows[0] }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'Name exists' : 'Update failed' }); }
}
const CAT_ADMIN = ['admin','mainadmin'];
app.put('/api/categories/:id', authRole(CAT_ADMIN), updateCategory);
app.post(['/api/categories/:id/rename', '/api/categories/:id/enable', '/api/admin/categories/rename', '/api/admin/categories/enable'], authRole(CAT_ADMIN), updateCategory);
app.post(['/api/categories/:id/toggle', '/api/admin/categories/toggle'], authRole(CAT_ADMIN), updateCategory);
app.delete('/api/categories/:id', authRole(CAT_ADMIN), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM categories WHERE id=$1 RETURNING *', [req.params.id]);
  res.json(rows.length ? { ok: true, category: rows[0] } : { error: 'Not found' }, rows.length ? 200 : 404);
});

/* ===================== Routes: Expenses ===================== */
app.get('/api/expenses/list', authRole(['user','admin','mainadmin']), async (req, res) => {
  const isAdmin = ['admin','mainadmin'].includes(req.user.role);
  const q = (req.query.category || '').trim().toLowerCase();
  let where = [], vals = [];
  if (q) where.push(`lower(category)=$${vals.push(q)}`);
  if (isAdmin) {
    const s = (req.query.status||'approved').toLowerCase();
    if (s !== 'all') where.push(`approved=${s === 'approved'}`);
    if (!toBool(req.query.includeDisabled)) where.push('enabled=true');
  } else {
    where.push(`((approved=true AND enabled=true)${toBool(req.query.includePendingMine||req.query.mine) ? ` OR (submitted_by=$${vals.push(req.user.username)} AND approved=false)` : ''})`);
  }
  const { rows } = await pool.query(`SELECT * FROM expenses ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY COALESCE(date, created_at) DESC`, vals);
  res.json(rows);
});

app.post('/api/expenses/submit', authRole(['user','admin','mainadmin']), async (req, res) => {
  const { amount, category, eventName, description, paidTo, date } = req.body;
  const cat = (category || eventName || '').trim(), amt = Number(amount);
  if (!cat || !Number.isFinite(amt)) return res.status(400).json({ error: 'Invalid data' });
  const now = new Date();
  const { rows } = await pool.query(`INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, submitted_by, submitted_by_id) VALUES ($1, $2, $3, $4, $5, $6, $6, true, false, 'pending', $7, $8) RETURNING *`, [amt, cat, description||'', paidTo||'', date?new Date(date):now, now, req.user.username, req.user.id]);
  res.status(201).json({ message: 'Submitted', expense: rows[0] });
});

app.post('/api/expenses', authRole(['admin','mainadmin']), async (req, res) => {
  const { amount, category, description, paidTo, date, approveNow } = req.body;
  const apprv = toBool(approveNow ?? true), now = new Date();
  const { rows } = await pool.query(`INSERT INTO expenses (amount, category, description, paid_to, date, created_at, updated_at, enabled, approved, status, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5, $6, $6, true, $7, $8, $9, $10) RETURNING *`, [amount, category, description, paidTo, date?new Date(date):now, now, apprv, apprv?'approved':'pending', apprv?req.user.username:null, apprv?now:null]);
  res.status(201).json({ message: 'Created', expense: rows[0] });
});

app.put('/api/expenses/:id', authRole(['admin','mainadmin']), async (req, res) => {
  const b = req.body, f = [], v = [req.params.id]; let i = 2;
  if (b.amount!==undefined) { f.push(`amount=$${i++}`); v.push(Number(b.amount)); }
  if (b.category!==undefined) { f.push(`category=$${i++}`); v.push(b.category.trim()); }
  if (b.description!==undefined) { f.push(`description=$${i++}`); v.push(b.description.trim()); }
  if (b.paidTo!==undefined) { f.push(`paid_to=$${i++}`); v.push(b.paidTo.trim()); }
  if (b.date!==undefined) { f.push(`date=$${i++}`); v.push(new Date(b.date)); }
  if (b.enabled!==undefined) { f.push(`enabled=$${i++}`); v.push(toBool(b.enabled)); }
  if (!f.length) return res.status(400).json({ error: 'No fields' });
  f.push('updated_at=now()');
  const { rows } = await pool.query(`UPDATE expenses SET ${f.join(', ')} WHERE id=$1 RETURNING *`, v);
  rows.length ? res.json({ message: 'Updated', expense: rows[0] }) : res.status(404).json({ error: 'Not found' });
});

app.post('/admin/expenses/:id/approve', authRole(['admin','mainadmin']), async (req, res) => {
  const apprv = toBool(req.body.approve ?? true);
  const { rows } = await pool.query(`UPDATE expenses SET approved=$1, status=$2, approved_by=$3, approved_at=$4, updated_at=now() WHERE id=$5 RETURNING *`, [apprv, apprv?'approved':'pending', apprv?req.user.username:null, apprv?new Date():null, req.params.id]);
  rows.length ? res.json({ message: apprv?'Approved':'Pending', expense: rows[0] }) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/expenses/:id', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING *', [req.params.id]);
  rows.length ? res.json({ message: 'Deleted', expense: rows[0] }) : res.status(404).json({ error: 'Not found' });
});

/* ===================== Routes: Donations ===================== */
const donationUpload = multer({ storage: new CloudinaryStorage({ cloudinary, params: { folder: 'setapur/screenshots', allowed_formats: ['jpg','png','webp'], resource_type: 'image' } }), limits: { fileSize: 10e6 } });

app.post(['/api/donations/submit-donation', '/api/donations/create'], authRole(['user','admin','mainadmin']), donationUpload.single('screenshot'), async (req, res) => {
  const { amount, paymentMethod, category, donorName } = req.body;
  if (!amount || !category || !donorName) return res.status(400).json({ error: 'Missing fields' });
  let code; do { code = generate6CharAlnumMix(); } while ((await pool.query('SELECT 1 FROM donations WHERE receipt_code=$1', [code])).rows.length > 0);
  const { rows } = await pool.query(`INSERT INTO donations (donor_user_id, donor_username, donor_name, amount, payment_method, category, approved, status, screenshot_public_id, screenshot_url, receipt_code) VALUES ($1, $2, $3, $4, $5, $6, false, 'pending', $7, $8, $9) RETURNING *`, [req.user.id, req.user.username, donorName.trim(), amount, paymentMethod, category, req.file?.filename, req.file?.path, code]);
  res.status(201).json({ message: 'Submitted', donation: rows[0] });
});

app.get('/api/donations/donations', authRole(['user','admin','mainadmin']), async (req, res) => {
  const isAdmin = ['admin','mainadmin'].includes(req.user.role), q = (req.query.q||'').trim().toLowerCase();
  let sql = 'SELECT * FROM donations WHERE 1=1', vals = [];
  if (!isAdmin) sql += ` AND (donor_username=$${vals.push(req.user.username)} OR donor_name=$${vals.length})`;
  const s = (req.query.status||'approved').toLowerCase();
  if (s==='pending') sql += ' AND approved=false'; else if (s==='approved') sql += ' AND approved=true';
  if (q) sql += ` AND (lower(donor_name) ILIKE $${vals.push(`%${q}%`)} OR lower(receipt_code) ILIKE $${vals.length})`;
  const { rows } = await pool.query(sql + ' ORDER BY created_at DESC', vals);
  res.json(rows.map(d => (!isAdmin && d.approved ? { ...d, screenshot_url: null } : d)));
});

app.post('/admin/donations/:id/approve', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query(`UPDATE donations SET approved=true, status='approved', approved_by=$1, approved_at=now(), updated_at=now() WHERE id=$2 RETURNING *`, [req.user.username, req.params.id]);
  rows.length ? res.json({ message: 'Approved', donation: rows[0] }) : res.status(404).json({ error: 'Not found' });
});

/* ===================== Routes: Gallery (RESTORED) ===================== */
const galleryUpload = multer({ storage: new CloudinaryStorage({ cloudinary, params: async (req, file) => ({ folder: `setapur/gallery/${req.params.slug||'_root'}`, public_id: `${Date.now()}-${slugify(path.parse(file.originalname).name)}`, resource_type: 'image' }) }), limits: { fileSize: 20e6, files: 25 } });

app.get('/gallery/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  const isAdmin = ['admin','mainadmin'].includes(req.user.role);
  const { rows } = await pool.query(`SELECT * FROM gallery_folders ${!isAdmin && !toBool(req.query.includeDisabled) ? 'WHERE enabled=true' : ''} ORDER BY order_index ASC, lower(name) ASC`);
  res.json(rows);
});

app.post('/gallery/folders/create', authRole(['admin','mainadmin']), async (req, res) => {
  const name = (req.body.name||'').trim(); if (!name) return res.status(400).json({ error: 'Name required' });
  try { await pool.query(`INSERT INTO gallery_folders (slug, name, enabled, order_index) VALUES ($1, $2, true, COALESCE((SELECT MAX(order_index)+1 FROM gallery_folders),0))`, [slugify(name), name]); res.status(201).json({ name, slug: slugify(name) }); }
  catch (e) { res.status(409).json({ error: 'Folder exists' }); }
});

app.post('/gallery/folders/:slug/upload', authRole(['admin','mainadmin']), galleryUpload.array('images', 25), async (req, res) => {
  const slug = req.params.slug||'_root';
  if (slug !== '_root') await pool.query(`INSERT INTO gallery_folders (slug, name, enabled, order_index) VALUES ($1, $1, true, 0) ON CONFLICT (slug) DO NOTHING`, [slug]);
  let { rows: [{ m }] } = await pool.query('SELECT COALESCE(MAX(order_index), -1) AS m FROM gallery_images WHERE folder_slug=$1', [slug]);
  let order = m + 1, inserted = [];
  for (const f of req.files || []) {
    const { rows } = await pool.query(`INSERT INTO gallery_images (folder_slug, public_id, url, filename, enabled, order_index) VALUES ($1,$2,$3,$4,true,$5) RETURNING *`, [slug, f.filename, f.path, f.originalname, order++]);
    inserted.push(rows[0]);
  }
  res.status(201).json({ uploaded: inserted, count: inserted.length });
});

app.get(['/gallery/images', '/gallery/folders/:slug/images'], authRole(['user','admin','mainadmin']), async (req, res) => {
  const slug = req.params.slug || '_root', isAdmin = ['admin','mainadmin'].includes(req.user.role);
  const { rows } = await pool.query(`SELECT * FROM gallery_images WHERE folder_slug=$1 ${!isAdmin && !toBool(req.query.includeDisabled) ? 'AND enabled=true' : ''} ORDER BY order_index ASC`, [slug]);
  res.json(rows);
});

app.post('/gallery/folders/:slug/reorder', authRole(['admin','mainadmin']), async (req, res) => {
  const { slug } = req.params, { direction, newIndex } = req.body;
  const { rows } = await pool.query('SELECT slug FROM gallery_folders ORDER BY order_index ASC');
  let list = rows.map(r => r.slug), idx = list.indexOf(slug);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (typeof newIndex === 'number') list.splice(newIndex, 0, list.splice(idx, 1)[0]);
  else if (direction === 'up' && idx > 0) [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  else if (direction === 'down' && idx < list.length-1) [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  for (let i=0; i<list.length; i++) await pool.query('UPDATE gallery_folders SET order_index=$1 WHERE slug=$2', [i, list[i]]);
  res.json({ ok: true, order: list });
});

app.post('/gallery/folders/:slug/images/reorder', authRole(['admin','mainadmin']), async (req, res) => {
  const { slug } = req.params, { id, direction, newIndex } = req.body;
  const { rows } = await pool.query('SELECT id FROM gallery_images WHERE folder_slug=$1 ORDER BY order_index ASC', [slug]);
  let list = rows.map(r => r.id), idx = list.indexOf(Number(id));
  if (idx === -1) return res.status(404).json({ error: 'Image not found' });
  if (typeof newIndex === 'number') list.splice(newIndex, 0, list.splice(idx, 1)[0]);
  else if (direction === 'up' && idx > 0) [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  else if (direction === 'down' && idx < list.length-1) [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  for (let i=0; i<list.length; i++) await pool.query('UPDATE gallery_images SET order_index=$1 WHERE id=$2', [i, list[i]]);
  res.json({ ok: true });
});

app.delete('/gallery/folders/:slug/images', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM gallery_images WHERE id=$1 RETURNING *', [req.body.id || req.query.id]);
  if (rows.length) try { await cloudinary.uploader.destroy(rows[0].public_id); } catch (_) {}
  res.json(rows.length ? { ok: true } : { error: 'Not found' }, rows.length ? 200 : 404);
});

app.post('/gallery/folders/:slug/cover', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gallery_images WHERE id=$1', [req.body.id]);
  if (!rows.length) return res.status(404).json({ error: 'Image not found' });
  await pool.query('UPDATE gallery_folders SET cover_public_id=$1, cover_url=$2 WHERE slug=$3', [rows[0].public_id, rows[0].url, req.params.slug]);
  res.json({ ok: true });
});

/* ===================== Routes: E-books (RESTORED) ===================== */
const ebookUpload = multer({ storage: new CloudinaryStorage({ cloudinary, params: async (req, file) => ({ folder: req.params.slug ? `setapur/ebooks/${req.params.slug}` : 'setapur/ebooks', public_id: `${Date.now()}-${slugify(path.parse(file.originalname).name)}`, resource_type: 'raw', allowed_formats: ['pdf'] }) }), limits: { fileSize: 100e6, files: 25 } });

app.get('/ebooks/folders', authRole(['user','admin','mainadmin']), async (req, res) => {
  const isAdmin = ['admin','mainadmin'].includes(req.user.role);
  const { rows } = await pool.query(`SELECT * FROM ebook_folders ${!isAdmin && !toBool(req.query.includeDisabled) ? 'WHERE enabled=true' : ''} ORDER BY lower(name) ASC`);
  res.json(rows);
});

app.post('/ebooks/folders/create', authRole(['admin','mainadmin']), async (req, res) => {
  const name = (req.body.name||'').trim(); if (!name) return res.status(400).json({ error: 'Name required' });
  try { await pool.query(`INSERT INTO ebook_folders (slug, name, enabled) VALUES ($1, $2, true)`, [slugify(name), name]); res.status(201).json({ name, slug: slugify(name) }); }
  catch (e) { res.status(409).json({ error: 'Folder exists' }); }
});

app.post(['/ebooks/upload', '/ebooks/folders/:slug/upload'], authRole(['admin','mainadmin']), ebookUpload.array('files', 25), async (req, res) => {
  const slug = req.params.slug || null;
  let { rows: [{ m }] } = await pool.query(slug ? 'SELECT COALESCE(MAX(order_index), -1) AS m FROM ebook_files WHERE folder_slug=$1' : 'SELECT COALESCE(MAX(order_index), -1) AS m FROM ebook_files WHERE folder_slug IS NULL', slug ? [slug] : []);
  let order = m + 1, inserted = [];
  for (const f of req.files || []) {
    const { rows } = await pool.query(`INSERT INTO ebook_files (folder_slug, public_id, url, filename, enabled, order_index) VALUES ($1,$2,$3,$4,true,$5) RETURNING *`, [slug, f.filename, f.path, f.originalname, order++]);
    inserted.push(rows[0]);
  }
  res.status(201).json({ uploaded: inserted, count: inserted.length });
});

app.get(['/ebooks/files', '/ebooks/folders/:slug/files'], authRole(['user','admin','mainadmin']), async (req, res) => {
  const slug = req.params.slug || null, isAdmin = ['admin','mainadmin'].includes(req.user.role);
  const sql = `SELECT * FROM ebook_files WHERE ${slug ? 'folder_slug=$1' : 'folder_slug IS NULL'} ${!isAdmin && !toBool(req.query.includeDisabled) ? 'AND enabled=true' : ''} ORDER BY order_index ASC`;
  const { rows } = await pool.query(sql, slug ? [slug] : []);
  res.json(rows);
});

app.delete('/ebooks/files', authRole(['admin','mainadmin']), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM ebook_files WHERE id=$1 RETURNING *', [req.body.id || req.query.id]);
  if (rows.length) try { await cloudinary.uploader.destroy(rows[0].public_id, { resource_type: 'raw' }); } catch (_) {}
  res.json(rows.length ? { ok: true } : { error: 'Not found' }, rows.length ? 200 : 404);
});

/* ===================== Totals & Start ===================== */
app.get('/totals', authRole(['user','admin','mainadmin']), async (req, res) => {
  const { rows: d } = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM donations WHERE approved=true');
  const { rows: e } = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE approved=true AND enabled=true');
  res.json({ totalDonation: Number(d[0].total), totalExpense: Number(e[0].total), balance: Number(d[0].total) - Number(e[0].total) });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

(async () => {
  try { await ensureAllTables(); await seedAdmin(); app.listen(PORT, HOST, () => console.log(`Server running on http://${HOST}:${PORT}`)); }
  catch (e) { console.error('Startup failed:', e); process.exit(1); }
})();