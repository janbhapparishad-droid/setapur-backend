/* --- server.js (FULL: existing APIs + Setapur AI /ai/chat) --- */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// Donations (source of truth you already have)
const { addOrApproveDonation, donations, saveDonations } = require('./controllers/receiptController');

// Routers/models you already have
const adminRoutes = require('./routes/adminRoutes');
const { getUsers, saveUsers } = require('./models/jsonDb');
const categoryRoutes = require('./routes/categoryRoutes');

// Analytics admin + store
const analyticsAdminRoutes = require('./routes/analyticsAdminRoutes');
const { readFolders, writeFolders } = require('./models/analyticsStore');

// Optional analytics/totals routers
let analyticsRoutes = null;
let totalsRoutes = null;
try { analyticsRoutes = require('./routes/analyticsRoutes'); } catch { console.warn('routes/analyticsRoutes.js not found, skipping.'); }
try { totalsRoutes = require('./routes/totalsRoutes'); } catch { console.warn('routes/totalsRoutes.js not found, using fallback /totals.'); }

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request log (path confirm) — add after app.use(bodyParser.json())
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

// Dev helper: allow ?token=... as Authorization
app.use((req, res, next) => {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// Static uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Gallery root
const galleryDir = path.join(uploadsDir, 'gallery');
if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });

// Multer for generic screenshot upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ========== Multer for gallery uploads ==========
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const GALLERY_ALLOWED_EXTS = IMG_EXT;

const galleryStoragePerFolder = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const slug = String(req.params.slug || '').trim();
      if (!slug) return cb(new Error('slug required'));
      const targetDir = path.join(galleryDir, slug);
      const safeRoot = path.resolve(galleryDir);
      const targetAbs = path.resolve(targetDir);
      if (!targetAbs.startsWith(safeRoot)) return cb(new Error('Invalid slug'));
      if (!fs.existsSync(targetAbs)) fs.mkdirSync(targetAbs, { recursive: true });
      cb(null, targetAbs);
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
    if (GALLERY_ALLOWED_EXTS.has(ext)) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: 25 },
});

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
    if (GALLERY_ALLOWED_EXTS.has(ext)) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: 25 },
});
// =====================================================

const SECRET_KEY = process.env.JWT_SECRET || 'your_secret_key_here';

/* ===================== Startup admin auto-seed (no shell needed) ===================== */
(function seedAdmin() {
  try {
    const users = (getUsers && getUsers()) || [];
    const username = process.env.INIT_ADMIN_USERNAME || 'admin';
    const password = process.env.INIT_ADMIN_PASSWORD || 'Admin@123';
    const role = 'mainadmin';

    const resetFlag = String(process.env.INIT_ADMIN_RESET || '').toLowerCase();
    const shouldReset = resetFlag === '1' || resetFlag === 'true';

    const idx = Array.isArray(users) ? users.findIndex(u => String(u.username) === String(username)) : -1;

    if (idx === -1) {
      const id = (Array.isArray(users) ? users.reduce((m,u)=>Math.max(m, Number(u.id)||0),0) : 0) + 1;
      const hash = bcrypt.hashSync(password, 10);
      const next = Array.isArray(users) ? users.slice() : [];
      next.push({ id, username, passwordHash: hash, role, banned: false });
      saveUsers(next);
      console.log(`Seeded admin user '${username}'`);
    } else if (shouldReset) {
      const next = users.slice();
      next[idx].passwordHash = bcrypt.hashSync(password, 10);
      next[idx].role = role;
      next[idx].banned = false;
      saveUsers(next);
      console.log(`Reset admin user '${username}'`);
    } else {
      console.log(`Admin user '${username}' already exists; skipping seed`);
    }
  } catch (e) {
    console.warn('Admin seed skipped:', e.message);
  }
})();

/* ===================== Auth middleware (Option 2) ===================== */
function normRole(r) {
  return String(r || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}
function authRole(roles) {
  const allowed = (Array.isArray(roles) ? roles : [roles]).map(normRole);
  return (req, res, next) => {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).send('Access Denied');
    try {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
      const verified = jwt.verify(token, SECRET_KEY);
      verified.role = normRole(verified.role);
      verified.username = String(verified.username || '');
      req.user = verified; // { id, username, role }

      if (!allowed.includes(req.user.role) && !allowed.includes('any')) {
        return res.status(403).send('Forbidden');
      }
      try {
        const users = getUsers();
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

/* ===================== Helpers ===================== */
const SENSITIVE_KEYS = [
  'screenshotUrl', 'screenshotPath', 'paymentScreenshot', 'screenshot',
  'cashReceiverName', 'receiverName', 'receivedBy',
];
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
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
function readJSONSafe(p, def = {}) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (_) {}
  return def;
}
function writeJSONSafe(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (_) {}
}
function pushNotification(username, notif) {
  // optional: wire to in-memory if needed
}

/* ===================== Gallery helpers ===================== */
const galleryRootMetaPath = path.join(galleryDir, '_meta.json');

function loadRootMeta() {
  const def = { folderOrder: [], rootImageOrder: [], disabledRootImages: {} };
  const meta = readJSONSafe(galleryRootMetaPath, def);
  meta.folderOrder = Array.isArray(meta.folderOrder) ? meta.folderOrder : [];
  meta.rootImageOrder = Array.isArray(meta.rootImageOrder) ? meta.rootImageOrder : [];
  meta.disabledRootImages = meta.disabledRootImages && typeof meta.disabledRootImages === 'object' ? meta.disabledRootImages : {};
  return meta;
}
function saveRootMeta(meta) { writeJSONSafe(galleryRootMetaPath, meta || {}); }

function folderMetaPath(slug) { return path.join(galleryDir, slug, 'meta.json'); }
function getFolderMeta(slug) {
  const p = folderMetaPath(slug);
  const meta = readJSONSafe(p, {});
  if (!('enabled' in meta)) meta.enabled = true;
  if (!Array.isArray(meta.imageOrder)) meta.imageOrder = [];
  if (!meta.disabledImages || typeof meta.disabledImages !== 'object') meta.disabledImages = {};
  return { meta, p };
}
function saveFolderMeta(slug, meta) { writeJSONSafe(folderMetaPath(slug), meta); }

function sortByOrder(items, idGetter, orderArr) {
  const idx = new Map();
  (orderArr || []).forEach((id, i) => idx.set(String(id), i));
  return items.slice().sort((a, b) => {
    const ia = idx.has(String(idGetter(a))) ? idx.get(String(idGetter(a))) : Number.MAX_SAFE_INTEGER;
    const ib = idx.has(String(idGetter(b))) ? idx.get(String(idGetter(b))) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    const na = String(a.name || '').toLowerCase();
    const nb = String(b.name || '').toLowerCase();
    return na.localeCompare(nb);
  });
}
function moveInArray(arr, id, direction, newIndex) {
  const a = arr.slice();
  const cur = a.indexOf(id);
  if (cur === -1) a.push(id);
  const old = a.indexOf(id);
  if (typeof newIndex === 'number') {
    a.splice(old, 1);
    a.splice(Math.max(0, Math.min(newIndex, a.length)), 0, id);
    return a;
  }
  if (direction === 'up' && old > 0) {
    [a[old - 1], a[old]] = [a[old], a[old - 1]];
  } else if (direction === 'down' && old >= 0 && old < a.length - 1) {
    [a[old + 1], a[old]] = [a[old], a[old + 1]];
  }
  return a;
}
function listFolderSlugs() {
  try {
    const entries = fs.readdirSync(galleryDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort((a,b)=>a.localeCompare(b));
  } catch (_) { return []; }
}
function ensureFolderOrderComplete() {
  const meta = loadRootMeta();
  const slugs = listFolderSlugs();
  const set = new Set(meta.folderOrder || []);
  let changed = false;
  for (const s of slugs) {
    if (!set.has(s)) {
      meta.folderOrder.push(s);
      set.add(s);
      changed = true;
    }
  }
  const live = new Set(slugs);
  const filtered = meta.folderOrder.filter(s => live.has(s));
  if (filtered.length !== meta.folderOrder.length) {
    meta.folderOrder = filtered;
    changed = true;
  }
  if (changed) saveRootMeta(meta);
  return meta;
}
function ensureRootOrderComplete() {
  const meta = loadRootMeta();
  let files = [];
  try {
    files = fs.readdirSync(galleryDir, { withFileTypes: true })
      .filter(ent => ent.isFile())
      .map(ent => ent.name)
      .filter(name => IMG_EXT.has(path.extname(name).toLowerCase()));
  } catch (_) { files = []; }
  const set = new Set(meta.rootImageOrder || []);
  let changed = false;
  for (const fn of files) {
    if (!set.has(fn)) {
      meta.rootImageOrder.push(fn);
      set.add(fn);
      changed = true;
    }
  }
  const live = new Set(files);
  const filtered = meta.rootImageOrder.filter(n => live.has(n));
  if (filtered.length !== meta.rootImageOrder.length) {
    meta.rootImageOrder = filtered;
    changed = true;
  }
  if (changed) saveRootMeta(meta);
  return meta;
}

/* ===================== Folders bootstrap ===================== */
function normalizeFoldersEvents(foldersIn) {
  return (foldersIn || []).map((f) => {
    const out = { ...f };
    const evs = Array.isArray(out.events) ? out.events : [];
    out.events = evs.map((ev) => {
      if (typeof ev === 'string') {
        return {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
          name: ev,
          enabled: true,
          showDonationDetail: true,
          showExpenseDetail: true,
        };
      }
      return {
        id: (ev && ev.id) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e9)}`),
        name: (ev && (ev.name || ev.eventName || ev.title || ev.label)) || '',
        enabled: ev && ev.enabled !== false,
        showDonationDetail: ev && ev.showDonationDetail !== false,
        showExpenseDetail: ev && ev.showExpenseDetail !== false,
      };
    });
    return out;
  });
}
let folders = readFolders();
if (!Array.isArray(folders) || folders.length === 0) {
  folders = [
    {
      id: 'default-1',
      name: 'shri krishna janmastami',
      events: [
        { id: 'evt-1', name: 'shri krishna janmastami 2025', enabled: true, showDonationDetail: true, showExpenseDetail: true },
        { id: 'evt-2', name: 'shri krishna chhathi 2025', enabled: true, showDonationDetail: true, showExpenseDetail: true },
      ],
    },
  ];
}
folders = normalizeFoldersEvents(folders);
writeFolders(folders);
app.locals.folders = folders;

/* ===================== Expenses API v2 (file store) ===================== */
let expenses = [];
const dataDir = path.join(__dirname, 'data');
const expensesFile = path.join(dataDir, 'expenses.json');

function ensureExpenseShape(e) {
  const nowIso = new Date().toISOString();
  return {
    id: Number(e.id) || 0,
    amount: Number(e.amount) || 0,
    category: (e.category || '').toString().trim(),
    description: (e.description || '').toString().trim(),
    paidTo: (e.paidTo || '').toString().trim(),
    date: e.date ? new Date(e.date).toISOString() : (e.date === null ? null : undefined),
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : nowIso,
    updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : nowIso,
    enabled: e.enabled === false ? false : true,
    approved: e.approved === true,
    status: e.status === 'pending' || e.approved !== true ? 'pending' : 'approved',
    submittedBy: e.submittedBy || null,
    submittedById: e.submittedById || null,
    approvedBy: e.approvedBy || null,
    approvedById: e.approvedById || null,
    approvedAt: e.approvedAt ? new Date(e.approvedAt).toISOString() : null,
  };
}
function loadExpenses() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(expensesFile)) {
      const raw = fs.readFileSync(expensesFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expenses = Array.isArray(parsed) ? parsed.map(ensureExpenseShape) : [];
    } else {
      expenses = [];
    }
  } catch (e) {
    console.warn('Failed to load expenses, starting empty:', e.message);
    expenses = [];
  }
  app.locals.expenses = expenses;
}
function saveExpenses() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(expensesFile, JSON.stringify(expenses, null, 2));
  } catch (e) {
    console.error('Failed to save expenses:', e.message);
  }
}
function nextExpenseId() {
  const maxId = (Array.isArray(expenses) ? expenses : []).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  return maxId + 1;
}
loadExpenses();
app.locals.expenses = expenses;

// List (users: approved+enabled; admin: can see all/pending/disabled)
app.get('/api/expenses/list', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.category || req.query.eventName || req.query.eventId || '').toString().trim().toLowerCase();
    const statusQ = (req.query.status || (isAdmin ? 'all' : 'approved')).toString().toLowerCase();
    const includeDisabledQ = (req.query.includeDisabled || '').toString().toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const includePendingMineQ = (req.query.includePendingMine || req.query.mine || '').toString().toLowerCase();
    const includePendingMine = includePendingMineQ === '1' || includePendingMineQ === 'true';

    let list = (Array.isArray(expenses) ? expenses : []).slice();

    if (q) list = list.filter(e => (e.category || '').toString().trim().toLowerCase() === q);

    if (isAdmin) {
      if (statusQ === 'approved') list = list.filter(e => e.approved === true);
      else if (statusQ === 'pending') list = list.filter(e => e.approved !== true);
      if (!includeDisabled) list = list.filter(e => e.enabled !== false);
    } else {
      let approvedEnabled = list.filter(e => e.approved === true && e.enabled !== false);
      if (includePendingMine && req.user && req.user.username) {
        const mine = list.filter(e => e.submittedBy === req.user.username && e.approved !== true);
        const ids = new Set(approvedEnabled.map(x => x.id));
        for (const x of mine) if (!ids.has(x.id)) approvedEnabled.push(x);
      }
      list = approvedEnabled;
    }

    list.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const db = b.date ? new Date(b.date).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return db - da;
    });

    res.json(list);
  } catch (e) {
    console.error('list expenses error:', e);
    res.status(500).send('Failed to list expenses');
  }
});

// User submit (pending)
app.post('/api/expenses/submit', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const { amount, category, eventName, description, paidTo, date } = req.body || {};
    const cat = (category || eventName || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category (event) is required' });
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });

    const now = new Date();
    const e = ensureExpenseShape({
      id: nextExpenseId(),
      amount: amt,
      category: cat,
      description: (description || '').toString().trim(),
      paidTo: (paidTo || '').toString().trim(),
      date: date ? new Date(date).toISOString() : now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      enabled: true,
      approved: false,
      status: 'pending',
      submittedBy: req.user?.username || null,
      submittedById: req.user?.id || null,
    });

    expenses.push(e);
    saveExpenses();
    app.locals.expenses = expenses;

    if (e.submittedBy) {
      pushNotification(e.submittedBy, {
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

// Admin create
app.post('/api/expenses', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { amount, category, description, paidTo, date, approveNow } = req.body || {};
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
    const cat = (category || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category is required' });

    const approve = approveNow !== false && approveNow !== 'false';
    const now = new Date();
    const e = ensureExpenseShape({
      id: nextExpenseId(),
      amount: amt,
      category: cat,
      description: (description || '').toString().trim(),
      paidTo: (paidTo || '').toString().trim(),
      date: date ? new Date(date).toISOString() : now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      enabled: true,
      approved: approve,
      status: approve ? 'approved' : 'pending',
      submittedBy: req.user?.username || null,
      submittedById: req.user?.id || null,
      approvedBy: approve ? req.user.username : null,
      approvedById: approve ? req.user.id : null,
      approvedAt: approve ? now.toISOString() : null,
    });

    expenses.push(e);
    saveExpenses();
    app.locals.expenses = expenses;

    res.status(201).json({ message: 'Expense created', expense: e });
  } catch (err) {
    console.error('create expense error:', err);
    res.status(500).send('Create expense failed');
  }
});

// Admin update
app.put('/api/expenses/:id', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });

    const body = req.body || {};
    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      expenses[idx].amount = amt;
    }
    if (typeof body.category === 'string') expenses[idx].category = body.category.trim();
    if (typeof body.description === 'string') expenses[idx].description = body.description.trim();
    if (typeof body.paidTo === 'string') expenses[idx].paidTo = body.paidTo.trim();
    if (body.date) expenses[idx].date = new Date(body.date).toISOString();
    if (body.enabled !== undefined) expenses[idx].enabled = body.enabled !== false && body.enabled !== 'false';

    expenses[idx].updatedAt = new Date().toISOString();
    saveExpenses();
    app.locals.expenses = expenses;

    res.json({ message: 'Expense updated', expense: expenses[idx] });
  } catch (err) {
    console.error('update expense error:', err);
    res.status(500).send('Update expense failed');
  }
});

// Admin enable/disable
app.post('/api/expenses/:id/enable', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    expenses[idx].enabled = enabled;
    expenses[idx].updatedAt = new Date().toISOString();
    saveExpenses();
    app.locals.expenses = expenses;
    res.json({ ok: true, expense: expenses[idx] });
  } catch (e) {
    console.error('enable expense error:', e);
    res.status(500).send('Failed to enable/disable expense');
  }
});

// Admin approve/disapprove (path with id)
app.post('/admin/expenses/:id/approve', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });

    const approveRaw = req.body.approve;
    const approve = approveRaw === true || approveRaw === 'true' || approveRaw === 1 || approveRaw === '1';

    expenses[idx].approved = approve;
    expenses[idx].status = approve ? 'approved' : 'pending';
    expenses[idx].approvedBy = req.user.username;
    expenses[idx].approvedById = req.user.id;
    expenses[idx].approvedAt = new Date().toISOString();
    expenses[idx].updatedAt = new Date().toISOString();

    const who = expenses[idx].submittedBy || null;
    if (who) {
      pushNotification(who, {
        type: `expense${approve ? 'Approval' : 'Pending'}`,
        title: `Expense ${approve ? 'approved' : 'set to pending'}`,
        body: `${expenses[idx].category} • ₹${expenses[idx].amount}`,
        data: { id: expenses[idx].id, category: expenses[idx].category, approved: approve },
      });
    }

    saveExpenses();
    app.locals.expenses = expenses;
    res.json({ message: `Expense ${approve ? 'approved' : 'set to pending'}`, expense: expenses[idx] });
  } catch (e) {
    console.error('approve expense error:', e);
    res.status(500).send('Approval failed');
  }
});

// Admin delete
app.delete('/api/expenses/:id', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
    const removed = expenses.splice(idx, 1)[0];
    saveExpenses();
    app.locals.expenses = expenses;
    res.json({ message: 'Expense deleted', expense: removed });
  } catch (err) {
    console.error('delete expense error:', err);
    res.status(500).send('Delete expense failed');
  }
});

/* ===================== Donations with search ===================== */
function normStr(x) { return String(x || '').toLowerCase().trim(); }
function matchesDonation(d, q) {
  const s = normStr(q);
  if (!s) return true;
  const name = normStr(d.donorName || d.donorUsername || '');
  const rc = normStr(d.receiptCode || d.code || '');
  const cat = normStr(d.category || '');
  return name.includes(s) || rc.includes(s) || cat.includes(s);
}

// ======= 6-char alphanumeric (must include letters + digits, unique) =======
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
function generateUniqueReceiptCode() {
  const used = new Set((donations || []).map(d => String(d.receiptCode || d.code || '').toUpperCase()));
  let code;
  let tries = 0;
  do {
    code = generate6CharAlnumMix();
    tries++;
  } while (used.has(code) && tries < 1000);
  return code;
}

// Submit donation (with screenshot)
function createDonationHandler(req, res) {
  try {
    const { amount, paymentMethod, category, cashReceiverName, donorName } = req.body;
    if (!donorName || !String(donorName).trim()) return res.status(400).json({ error: 'donorName is required' });
    if (!amount || !paymentMethod || !category) return res.status(400).json({ error: 'amount, paymentMethod, and category are required' });

    const code = generateUniqueReceiptCode();

    const fileName = req.file ? req.file.filename : null;
    const screenshotPath = fileName ? `uploads/${fileName}` : null;
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const screenshotUrl = fileName ? `${host}/uploads/${fileName}` : null;

    const donorUsername = req.user.username;
    const donorUserId = req.user.id;
    const donorDisplayName = (donorName && String(donorName).trim()) || donorUsername;

    const donation = {
      id: donations.length + 1,
      donorUserId,
      donorUsername,
      donorName: donorDisplayName,
      amount: Number(amount),
      paymentMethod,
      category,
      cashReceiverName: cashReceiverName || null,
      approved: false,
      status: 'pending',
      createdAt: new Date(),
      screenshotPath,
      screenshotUrl,
      code,
      receiptCode: code,
    };

    donations.push(donation);
    if (typeof saveDonations === 'function') saveDonations();
    return res.status(201).json({ message: 'Donation submitted', donation });
  } catch (err) {
    console.error('submit-donation error:', err);
    return res.status(500).send('Failed to submit donation');
  }
}
app.post('/api/donations/submit-donation', authRole(['user', 'admin', 'mainadmin']), upload.single('screenshot'), createDonationHandler);
// Alias: create
app.post('/api/donations/create', authRole(['user', 'admin', 'mainadmin']), upload.single('screenshot'), createDonationHandler);

// My account receipts (approved only)
app.get('/myaccount/receipts', authRole(['user', 'admin', 'mainadmin']), (req, res) => {
  const username = req.user.username;
  const userDonations = donations.filter((d) =>
    (d.donorUsername ? d.donorUsername === username : d.donorName === username) && isApproved(d)
  );
  res.json(userDonations);
});

// User/Admin list with q filter
app.get('/api/donations/donations', authRole(['user', 'admin', 'mainadmin']), (req, res) => {
  const status = String(req.query.status || 'approved').toLowerCase();
  const role = req.user.role;
  const q = (req.query.q || req.query.search || '').toString().trim();

  if ((role === 'admin' || role === 'mainadmin') && status === 'all') {
    let all = donations.slice();
    if (q) all = all.filter(d => matchesDonation(d, q));
    const outAll = all.map((d) => redactDonationForRole(d, role));
    return res.json(outAll);
  }

  let list = donations.filter((d) =>
    d.donorUsername ? d.donorUsername === req.user.username : d.donorName === req.user.username
  );
  if (status === 'pending') list = list.filter((d) => !isApproved(d));
  else if (status === 'approved') list = list.filter(isApproved);

  if (q) list = list.filter(d => matchesDonation(d, q));

  const out = list.map((d) => redactDonationForRole(d, role));
  return res.json(out);
});

// Admin all donations with q filter
app.get('/api/donations/all-donations', authRole(['admin', 'mainadmin']), (req, res) => {
  const role = req.user.role;
  const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const q = (req.query.q || req.query.search || '').toString().trim();

  let normalized = donations.map((d) => ({
    ...d,
    screenshotUrl:
      d.screenshotUrl || (d.screenshotPath ? `${host}/${String(d.screenshotPath).replace(/\\/g, '/')}` : null),
  }));

  if (q) normalized = normalized.filter(d => matchesDonation(d, q));

  const out = normalized.map((d) => redactDonationForRole(d, role));
  res.json(out);
});

// Universal donation search (role-safe)
app.get('/api/donations/search', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const q = (req.query.q || req.query.search || '').toString().trim();
    if (!q) return res.json([]);

    let base = donations.slice();

    if (!isAdmin) {
      const approvedOnly = base.filter(isApproved);
      const mineExtra = base.filter(d =>
        (d.donorUsername ? d.donorUsername === req.user.username : d.donorName === req.user.username)
      );
      const ids = new Set(approvedOnly.map(d => d.id));
      for (const d of mineExtra) if (!ids.has(d.id)) approvedOnly.push(d);
      base = approvedOnly;
    }

    let list = base.filter(d => matchesDonation(d, q));

    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    list = list.slice(0, 100);

    const out = list.map(d => redactDonationForRole(d, role));
    res.json(out);
  } catch (e) {
    console.error('donation search error:', e);
    res.status(500).send('Search failed');
  }
});

// Admin pending donations
app.get('/admin/donations/pending', authRole(['admin', 'mainadmin']), (req, res) => {
  const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const pending = (donations || [])
    .filter((d) => !isApproved(d))
    .map((d) => ({
      ...d,
      screenshotUrl:
        d.screenshotUrl || (d.screenshotPath ? `${host}/${String(d.screenshotPath).replace(/\\/g, '/')}` : null),
    }));
  res.json(pending);
});

// Admin approve a donation (enforces 6-char alphanumeric code)
app.post('/admin/donations/:id/approve', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = donations.findIndex((x) => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Donation not found' });

    const d = donations[idx];
    const alreadyApproved = isApproved(d);

    let approvedByName = req.user.username;
    try {
      const users = getUsers();
      const approver = users.find((u) => u.username === req.user.username);
      approvedByName = approver?.name || approver?.fullName || approver?.displayName || req.user.username;
    } catch (_) {}

    d.approved = true;
    d.status = 'approved';
    d.approvedBy = req.user.username;
    d.approvedById = req.user.id;
    d.approvedByRole = req.user.role;
    d.approvedByName = approvedByName;
    d.approvedAt = new Date();

    // Ensure 6-char A-Z0-9 with at least 1 letter + 1 digit
    const rc = String(d.receiptCode || '').toUpperCase();
    const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
    if (!valid) d.receiptCode = generateUniqueReceiptCode();

    const donorUser = d.donorUsername || d.donorName || null;
    const rcOut = d.receiptCode || d.code || '';
    if (donorUser && !alreadyApproved) {
      pushNotification(donorUser, {
        type: 'donationApproval',
        title: 'Donation approved',
        body: `Receipt: ${rcOut || 'N/A'} • Event: ${d.category} • Amount: ₹${Number(d.amount || 0)}`,
        data: { receiptCode: rcOut || null, category: d.category, amount: d.amount, paymentMethod: d.paymentMethod, approved: true },
      });
    }

    if (typeof saveDonations === 'function') saveDonations();
    return res.json({ message: 'Donation approved', donation: d });
  } catch (err) {
    console.error('admin approve error:', err);
    return res.status(500).send('Approval failed');
  }
});

// Admin disapprove (set pending)
app.post('/admin/donations/:id/disapprove', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { id } = req.params;
    const idx = donations.findIndex((x) => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Donation not found' });

    const d = donations[idx];

    d.approved = false;
    d.status = 'pending';
    d.approvedBy = null;
    d.approvedById = null;
    d.approvedByRole = null;
    d.approvedByName = null;
    d.approvedAt = null;
    d.updatedAt = new Date();

    if (typeof saveDonations === 'function') saveDonations();
    return res.json({ message: 'Donation set to pending', donation: d });
  } catch (err) {
    console.error('admin disapprove error:', err);
    return res.status(500).send('Disapprove failed');
  }
});

// Admin edit donation
function handleDonationUpdate(req, res) {
  try {
    const { id } = req.params;
    const idx = donations.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Donation not found' });

    const body = req.body || {};
    const d = donations[idx];

    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      d.amount = amt;
    }
    if (typeof body.donorName === 'string') d.donorName = body.donorName.trim();
    if (typeof body.category === 'string') d.category = body.category.trim();
    if (typeof body.paymentMethod === 'string') d.paymentMethod = body.paymentMethod.trim();
    if (typeof body.cashReceiverName === 'string') d.cashReceiverName = body.cashReceiverName.trim();

    // Optional: update receiptCode with validation + uniqueness
    if (typeof body.receiptCode === 'string' && body.receiptCode.trim()) {
      const rc = body.receiptCode.trim().toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      const dup = donations.some((x, i) => i !== idx && String(x.receiptCode || x.code || '').toUpperCase() === rc);
      if (!valid) return res.status(400).json({ error: 'receiptCode must be 6-char A-Z0-9 with at least 1 letter & 1 digit' });
      if (dup) return res.status(409).json({ error: 'receiptCode already exists' });
      d.receiptCode = rc;
    }
    if (body.regenerateReceiptCode === true || body.regenerateReceiptCode === 'true') {
      d.receiptCode = generateUniqueReceiptCode();
    }

    d.updatedAt = new Date();

    if (typeof saveDonations === 'function') saveDonations();
    return res.json({ message: 'Donation updated', donation: d });
  } catch (e) {
    console.error('update donation error:', e);
    res.status(500).send('Update donation failed');
  }
}
app.put('/admin/donations/:id', authRole(['admin', 'mainadmin']), handleDonationUpdate);
app.put('/api/donations/:id', authRole(['admin', 'mainadmin']), handleDonationUpdate);

// Alias: approve/disapprove via single endpoint (kept for your FE call)
app.post('/api/donations/approve', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { id, approve } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const idx = (donations || []).findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Donation not found' });
    const d = donations[idx];

    const wantApprove = (approve === true || approve === 'true' || approve === 1 || approve === '1');

    if (wantApprove) {
      const alreadyApproved = isApproved(d);

      let approvedByName = req.user.username;
      try {
        const users = getUsers();
        const approver = users.find(u => u.username === req.user.username);
        approvedByName = approver?.name || approver?.fullName || approver?.displayName || req.user.username;
      } catch (_) {}

      d.approved = true;
      d.status = 'approved';
      d.approvedBy = req.user.username;
      d.approvedById = req.user.id;
      d.approvedByRole = req.user.role;
      d.approvedByName = approvedByName;
      d.approvedAt = new Date();

      // ensure valid 6-char code
      const rc = String(d.receiptCode || '').toUpperCase();
      const valid = rc.length === 6 && /^[A-Z0-9]{6}$/.test(rc) && /[A-Z]/.test(rc) && /\d/.test(rc);
      if (!valid) d.receiptCode = generateUniqueReceiptCode();

      if (!alreadyApproved) {
        const donorUser = d.donorUsername || d.donorName || null;
        const rcOut = d.receiptCode || d.code || '';
        if (donorUser) {
          pushNotification(donorUser, {
            type: 'donationApproval',
            title: 'Donation approved',
            body: `Receipt: ${rcOut || 'N/A'} • Event: ${d.category} • Amount: ₹${Number(d.amount || 0)}`,
            data: { receiptCode: rcOut || null, category: d.category, amount: d.amount, paymentMethod: d.paymentMethod, approved: true },
          });
        }
      }

      if (typeof saveDonations === 'function') saveDonations();
      return res.json({ message: 'Donation approved', donation: d });
    } else {
      // Disapprove (set to pending)
      d.approved = false;
      d.status = 'pending';
      d.approvedBy = null;
      d.approvedById = null;
      d.approvedByRole = null;
      d.approvedByName = null;
      d.approvedAt = null;
      d.updatedAt = new Date();

      if (typeof saveDonations === 'function') saveDonations();
      return res.json({ message: 'Donation set to pending', donation: d });
    }
  } catch (e) {
    console.error('alias /api/donations/approve error:', e);
    res.status(500).send('Operation failed');
  }
});

/* ===================== Auth: Login (role normalized) ===================== */
app.post('/auth/login', async (req, res) => {
  const { username, password, deviceId } = req.body || {};
  const users = getUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(400).send('User not found');
  if (user.banned) return res.status(403).send('User banned');
  const validPass = await bcrypt.compare(password, user.passwordHash);
  if (!validPass) return res.status(400).send('Invalid password');

  user.loggedIn = deviceId; saveUsers(users);

  const cleanRole = normRole(user.role || 'user');
  const token = jwt.sign({ id: user.id, username: user.username, role: cleanRole }, SECRET_KEY, { expiresIn: '8h' });
  res.json({ token });
});

/* ===================== Setapur AI (/ai/chat) ===================== */
// Quick ping to verify AI section is mounted
app.get('/ai/ping', (req, res) => {
  res.json({ ok: true, provider: process.env.AI_PROVIDER || 'groq', ts: Date.now() });
});

/* Env:
   AI_PROVIDER=groq
   AI_MODEL=llama3-8b-8192
   GROQ_API_KEY=your_groq_api_key
*/
const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const AI_MODEL    = process.env.AI_MODEL    || 'llama3-8b-8192';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

function aiNormalizeMessages(messages = [], system = '') {
  const out = [];
  if (system && String(system).trim()) out.push({ role: 'system', content: String(system).trim() });
  for (const m of (messages || [])) {
    const role = (m && ['user','assistant','system'].includes(m.role)) ? m.role : 'user';
    const content = ((m && m.content) || '').toString();
    if (content.trim()) out.push({ role, content });
  }
  return out;
}

async function aiCallGroq({ messages, system }) {
  if (!GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model: AI_MODEL,
    messages: aiNormalizeMessages(messages, system),
    temperature: 0.6,
    top_p: 0.9,
    stream: false,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!content) throw new Error('Empty AI response');
  return content;
}

async function aiChatHandler(req, res) {
  try {
    if (AI_PROVIDER !== 'groq') {
      return res.status(500).json({ error: `Unsupported AI_PROVIDER=${AI_PROVIDER}` });
    }
    const { messages = [], system = '' } = req.body || {};
    const content = await aiCallGroq({ messages, system });
    res.json({ content });
  } catch (e) {
    console.error('AI chat error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
}

// Mount both paths so FE mismatch na ho
app.post('/ai/chat', authRole(['user','admin','mainadmin']), aiChatHandler);
app.post('/api/ai/chat', authRole(['user','admin','mainadmin']), aiChatHandler);
/* ===================== Setapur AI end ===================== */


/* ===================== Analytics summary (event-wise) ===================== */
app.get('/analytics/summary', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const foldersArr = app.locals.folders || [];
    const allDonations = Array.isArray(donations) ? donations : [];
    const allExpenses = Array.isArray(app.locals.expenses) ? app.locals.expenses : [];

    const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const isApprovedEnabledExpense = (e) => e && e.approved === true && e.enabled !== false;

    const out = [];

    for (const folder of foldersArr) {
      const events = Array.isArray(folder.events) ? folder.events : [];
      const eventsMap = {};

      for (const ev of events) {
        const evName = (ev && (ev.name || ev.eventName || ev.title || ev.label)) || '';
        const showDonationDetail = ev && ev.showDonationDetail !== false;
        const showExpenseDetail = ev && ev.showExpenseDetail !== false;

        const dList = allDonations.filter(d => isApproved(d) && eq(d.category, evName));
        const donationTotal = dList.reduce((s, d) => s + Number(d.amount || 0), 0);

        const eList = allExpenses.filter(e => isApprovedEnabledExpense(e) && eq(e.category, evName));
        const expenseTotal = eList.reduce((s, e) => s + Number(e.amount || 0), 0);

        const donationsSlim = dList.map(d => ({
          id: d.id,
          donorName: d.donorName || d.donorUsername || '',
          amount: Number(d.amount || 0),
          paymentMethod: d.paymentMethod || '',
          category: d.category || '',
          createdAt: d.createdAt || null,
          receiptCode: d.receiptCode || d.code || null,
        }));

        eventsMap[evName] = {
          donationTotal,
          expenseTotal,
          balance: donationTotal - expenseTotal,
          donations: donationsSlim,
          config: {
            showDonationDetail,
            showExpenseDetail,
            enabled: !(ev && ev.enabled === false),
          },
        };
      }

      out.push({
        folderName: folder.name || '',
        folderId: folder.id || '',
        events: eventsMap,
      });
    }

    return res.json(out);
  } catch (e) {
    console.error('analytics summary error:', e);
    res.status(500).send('Analytics summary failed');
  }
});

/* ===================== Gallery endpoints ===================== */

// GET /gallery/folders (admins always see disabled; users see only enabled; returns order)
app.get('/gallery/folders', authRole(['user', 'admin', 'mainadmin']), (req, res) => {
  try {
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });

    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const showDisabled = isAdmin || includeDisabled;

    const rootMeta = ensureFolderOrderComplete();
    const orderIdx = new Map(rootMeta.folderOrder.map((s,i) => [s, i]));

    const entries = fs.readdirSync(galleryDir, { withFileTypes: true });

    let foldersOut = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;

      const slug = ent.name;
      const folderPath = path.join(galleryDir, slug);
      const { meta } = getFolderMeta(slug);

      let name = meta.name || slug.replace(/-/g, ' ');
      let coverFile = null, coverUrl = null;
      let iconFile = null, iconUrl = null, iconKey = meta.iconKey || null;

      if (meta.cover) {
        const cf = String(meta.cover);
        if (fs.existsSync(path.join(folderPath, cf))) {
          coverFile = cf;
          coverUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(cf)}`;
        }
      }
      if (meta.iconFile) {
        const icf = String(meta.iconFile);
        if (fs.existsSync(path.join(folderPath, icf))) {
          iconFile = icf;
          iconUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(icf)}`;
        }
      }

      foldersOut.push({
        name,
        slug,
        url: `${host}/uploads/gallery/${slug}/`,
        cover: coverFile,
        coverUrl: coverUrl || null,
        iconFile,
        iconUrl: iconUrl || null,
        iconKey: iconKey || null,
        enabled: meta.enabled !== false,
        order: orderIdx.has(slug) ? orderIdx.get(slug) : 999999,
      });
    }

    foldersOut.sort((a,b) => {
      const ao = Number(a.order || 0);
      const bo = Number(b.order || 0);
      if (ao !== bo) return ao - bo;
      return String(a.name||'').toLowerCase().localeCompare(String(b.name||'').toLowerCase());
    });

    if (!showDisabled) foldersOut = foldersOut.filter(f => f.enabled !== false);

    res.json(foldersOut);
  } catch (e) {
    console.error('gallery list error:', e);
    res.status(500).send('Failed to list gallery folders');
  }
});

// GET /gallery/folders/:slug/images (admins always see disabled; users see only enabled)
app.get('/gallery/folders/:slug/images', authRole(['user', 'admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';

    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const showDisabled = isAdmin || includeDisabled;

    const folderPath = path.join(galleryDir, slug);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const { meta } = getFolderMeta(slug);

    const files = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(ent => ent.isFile())
      .map(ent => ent.name)
      .filter(name => IMG_EXT.has(path.extname(name).toLowerCase()));

    let list = files.map(fn => ({
      name: fn,
      url: `${host}/uploads/gallery/${slug}/${encodeURIComponent(fn)}`,
      enabled: !(meta.disabledImages && meta.disabledImages[fn] === true),
      mtime: fs.statSync(path.join(folderPath, fn)).mtimeMs,
      size: fs.statSync(path.join(folderPath, fn)).size
    }));

    list = sortByOrder(list, x => x.name, meta.imageOrder || []);

    if (!showDisabled) {
      list = list.filter(x => x.enabled !== false);
    }

    res.json(list.map(({ name, url, size, mtime, enabled }) => ({
      name, url, size, modifiedAt: new Date(mtime).toISOString(), enabled
    })));
  } catch (e) {
    console.error('gallery images error:', e);
    res.status(500).send('Failed to list images');
  }
});

// Root images: GET /gallery/images + alias /gallery/home/images
function getRootImagesHandler(req, res) {
  try {
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';

    const includeDisabled = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabled === '1' || includeDisabled === 'true';

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const meta = ensureRootOrderComplete(); // ensure order has all files
    const orderIdx = new Map((meta.rootImageOrder || []).map((n, i) => [n, i]));

    const files = fs.readdirSync(galleryDir, { withFileTypes: true })
      .filter(ent => ent.isFile())
      .map(ent => ent.name)
      .filter(name => IMG_EXT.has(path.extname(name).toLowerCase()));

    let list = files.map(fn => ({
      name: fn,
      url: `${host}/uploads/gallery/${encodeURIComponent(fn)}`,
      enabled: !(meta.disabledRootImages && meta.disabledRootImages[fn] === true),
      mtime: fs.statSync(path.join(galleryDir, fn)).mtimeMs,
      size: fs.statSync(path.join(galleryDir, fn)).size,
      order: orderIdx.has(fn) ? orderIdx.get(fn) : Number.MAX_SAFE_INTEGER,
    }));

    // Apply order and optional filter
    list.sort((a, b) => (a.order - b.order) || (String(a.name).localeCompare(String(b.name))));
    if (!showDisabled) list = list.filter(x => x.enabled !== false);

    res.json(list.map(({ name, url, size, mtime, enabled, order }) => ({
      name, url, size, modifiedAt: new Date(mtime).toISOString(), enabled, order
    })));
  } catch (e) {
    console.error('gallery root images error:', e);
    res.status(500).send('Failed to list gallery images');
  }
}
app.get('/gallery/images', authRole(['user', 'admin', 'mainadmin']), getRootImagesHandler);
app.get('/gallery/home/images', authRole(['user', 'admin', 'mainadmin']), getRootImagesHandler);

// Upload to folder
app.post('/gallery/folders/:slug/upload', authRole(['admin', 'mainadmin']), uploadGallery.array('images', 25), (req, res) => {
  try {
    const { slug } = req.params;
    const files = req.files || [];
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const uploaded = files.map((f) => ({
      name: f.filename,
      size: f.size,
      url: `${host}/uploads/gallery/${encodeURIComponent(slug)}/${encodeURIComponent(f.filename)}`,
    }));

    const { meta } = getFolderMeta(slug);
    meta.imageOrder = Array.isArray(meta.imageOrder) ? meta.imageOrder : [];
    for (const f of uploaded) {
      if (!meta.imageOrder.includes(f.name)) meta.imageOrder.push(f.name);
    }
    saveFolderMeta(slug, meta);

    return res.status(201).json({ uploaded, count: uploaded.length });
  } catch (e) {
    console.error('gallery upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Upload to root (outside folders) + alias
function rootUploadHandler(req, res) {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

    const meta = ensureRootOrderComplete();
    for (const f of files) {
      if (!meta.rootImageOrder.includes(f.filename)) meta.rootImageOrder.push(f.filename);
    }
    saveRootMeta(meta);

    const uploaded = files.map(f => ({
      name: f.filename,
      url: `${host}/uploads/gallery/${encodeURIComponent(f.filename)}`,
      size: f.size
    }));
    res.status(201).json({ uploaded, count: uploaded.length });
  } catch (e) {
    console.error('root upload error:', e);
    res.status(500).send('Upload failed');
  }
}
app.post('/gallery/upload', authRole(['admin', 'mainadmin']), uploadRootGallery.array('images', 25), rootUploadHandler);
app.post('/gallery/home/upload', authRole(['admin', 'mainadmin']), uploadRootGallery.array('images', 25), rootUploadHandler);

// Create folder
app.post('/gallery/folders/create', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    if (!slug) return res.status(400).json({ error: 'invalid name' });
    const dir = path.join(galleryDir, slug);
    if (fs.existsSync(dir)) return res.status(409).json({ error: 'folder already exists', slug });

    fs.mkdirSync(dir, { recursive: true });
    saveFolderMeta(slug, { name: String(name).trim(), enabled: true, imageOrder: [], disabledImages: {} });

    const meta = ensureFolderOrderComplete();
    if (!meta.folderOrder.includes(slug)) {
      meta.folderOrder.push(slug);
      saveRootMeta(meta);
    }

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return res.status(201).json({ name: String(name).trim(), slug, url: `${host}/uploads/gallery/${slug}/` });
  } catch (e) {
    console.error('gallery create error:', e);
    res.status(500).send('Failed to create folder');
  }
});

// Set cover
app.post('/gallery/folders/:slug/cover', authRole(['admin', 'mainadmin']), (req, res) => {
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
    const ext = path.extname(filename).toLowerCase();
    if (!IMG_EXT.has(ext)) return res.status(400).json({ error: 'Invalid image extension' });

    const { meta } = getFolderMeta(slug);
    meta.cover = filename;
    saveFolderMeta(slug, meta);
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const coverUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(filename)}`;
    res.json({ ok: true, slug, cover: filename, coverUrl });
  } catch (e) {
    console.error('set cover error:', e);
    res.status(500).send('Failed to set cover');
  }
});

// Built-in icon keys allowed
const ALLOWED_ICON_KEYS = new Set([
  'temple','event','flower','music','book','home','star','people','calendar','camera','donation','festival'
]);
// Set/Clear icon (file or built-in)
app.post('/gallery/folders/:slug/icon', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, iconKey, clear } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const folderPath = path.join(galleryDir, slug);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });

    const { meta } = getFolderMeta(slug);

    if (clear === true || clear === 'true' || clear === 1 || clear === '1') {
      delete meta.iconFile; delete meta.iconKey;
      saveFolderMeta(slug, meta);
      return res.json({ ok: true, slug, iconFile: null, iconKey: null, iconUrl: null });
    }

    if (filename && String(filename).trim()) {
      const fn = String(filename).trim();
      const target = path.resolve(path.join(folderPath, fn));
      const safeRoot = path.resolve(folderPath);
      if (!target.startsWith(safeRoot) || !fs.existsSync(target)) return res.status(404).json({ error: 'file not found in folder' });
      const ext = path.extname(fn).toLowerCase();
      if (!IMG_EXT.has(ext)) return res.status(400).json({ error: 'Invalid image extension' });
      meta.iconFile = fn; delete meta.iconKey;
      saveFolderMeta(slug, meta);
      const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const iconUrl = `${host}/uploads/gallery/${slug}/${encodeURIComponent(fn)}`;
      return res.json({ ok: true, slug, iconFile: fn, iconKey: null, iconUrl });
    }

    if (iconKey && String(iconKey).trim()) {
      const key = String(iconKey).trim();
      if (!ALLOWED_ICON_KEYS.has(key)) return res.status(400).json({ error: 'Invalid iconKey', allowed: Array.from(ALLOWED_ICON_KEYS) });
      meta.iconKey = key; delete meta.iconFile;
      saveFolderMeta(slug, meta);
      return res.json({ ok: true, slug, iconFile: null, iconKey: key, iconUrl: null });
    }

    return res.status(400).json({ error: 'Provide filename OR iconKey OR clear=true' });
  } catch (e) {
    console.error('set icon error:', e);
    res.status(500).send('Failed to set icon');
  }
});

// Enable/disable folder (does NOT delete)
app.post('/gallery/folders/:slug/enable', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';

    const folderPath = path.join(galleryDir, slug);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });

    const { meta } = getFolderMeta(slug);
    meta.enabled = enabled;
    saveFolderMeta(slug, meta);
    res.json({ ok: true, slug, enabled });
  } catch (e) {
    console.error('enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

// Reorder folders (support both endpoints)
app.post('/gallery/folders/reorder', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug, direction, newIndex } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const meta = ensureFolderOrderComplete();
    meta.folderOrder = Array.from(new Set(meta.folderOrder));
    meta.folderOrder = moveInArray(meta.folderOrder, slug, direction, typeof newIndex === 'number' ? newIndex : undefined);
    saveRootMeta(meta);
    res.json({ ok: true, folderOrder: meta.folderOrder });
  } catch (e) {
    console.error('reorder folders error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});
app.post('/gallery/folders/:slug/reorder', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const { direction, newIndex } = req.body || {};
    const meta = ensureFolderOrderComplete();
    meta.folderOrder = Array.from(new Set(meta.folderOrder));
    meta.folderOrder = moveInArray(meta.folderOrder, slug, direction, typeof newIndex === 'number' ? newIndex : undefined);
    saveRootMeta(meta);
    res.json({ ok: true, folderOrder: meta.folderOrder });
  } catch (e) {
    console.error('reorder folders (param) error:', e);
    res.status(500).send('Failed to reorder folders');
  }
});

// Rename folder
app.post('/gallery/folders/:slug/rename', authRole(['admin', 'mainadmin']), (req, res) => {
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
    const { meta } = getFolderMeta(newSlug);
    meta.name = desired;
    saveFolderMeta(newSlug, meta);

    const rootMeta = ensureFolderOrderComplete();
    rootMeta.folderOrder = rootMeta.folderOrder.map(s => s === slug ? newSlug : s);
    saveRootMeta(rootMeta);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, slug: newSlug, name: meta.name, url: `${host}/uploads/gallery/${newSlug}/` });
  } catch (e) {
    console.error('rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

// Delete folder
app.delete('/gallery/folders/:slug', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const dir = path.join(galleryDir, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    const meta = ensureFolderOrderComplete();
    meta.folderOrder = meta.folderOrder.filter(s => s !== slug);
    saveRootMeta(meta);
    res.json({ ok: true, slug });
  } catch (e) {
    console.error('delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

// Reorder images inside folder
app.post('/gallery/folders/:slug/images/reorder', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const { filename, direction, newIndex } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const { meta } = getFolderMeta(slug);
    meta.imageOrder = moveInArray(meta.imageOrder || [], String(filename), direction, typeof newIndex === 'number' ? newIndex : undefined);
    saveFolderMeta(slug, meta);
    res.json({ ok: true, imageOrder: meta.imageOrder });
  } catch (e) {
    console.error('reorder images error:', e);
    res.status(500).send('Failed to reorder images');
  }
});

// Enable/disable image inside folder
app.post('/gallery/folders/:slug/images/enable', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const { meta } = getFolderMeta(slug);
    meta.disabledImages = meta.disabledImages || {};
    if (enabled) delete meta.disabledImages[filename];
    else meta.disabledImages[filename] = true;
    saveFolderMeta(slug, meta);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('enable image error:', e);
    res.status(500).send('Failed to update image enabled');
  }
});

// Rename image inside folder
app.post('/gallery/folders/:slug/images/rename', authRole(['admin', 'mainadmin']), (req, res) => {
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

    const { meta } = getFolderMeta(slug);
    meta.imageOrder = (meta.imageOrder || []).map(n => n === filename ? targetName : n);
    if (meta.disabledImages && meta.disabledImages[filename]) {
      delete meta.disabledImages[filename];
      meta.disabledImages[targetName] = true;
    }
    if (meta.cover === filename) meta.cover = targetName;
    if (meta.iconFile === filename) meta.iconFile = targetName;
    saveFolderMeta(slug, meta);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/gallery/${slug}/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('rename image error:', e);
    res.status(500).send('Failed to rename image');
  }
});

// Delete image inside folder
app.delete('/gallery/folders/:slug/images', authRole(['admin', 'mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const p = path.join(galleryDir, slug, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
    fs.unlinkSync(p);

    const { meta } = getFolderMeta(slug);
    meta.imageOrder = (meta.imageOrder || []).filter(n => n !== filename);
    if (meta.disabledImages) delete meta.disabledImages[filename];
    if (meta.cover === filename) delete meta.cover;
    if (meta.iconFile === filename) delete meta.iconFile;
    saveFolderMeta(slug, meta);

    res.json({ ok: true, filename });
  } catch (e) {
    console.error('ebooks delete file error:', e);
    res.status(500).send('Failed to delete file');
  }
});

// Root images reorder + aliases
function rootReorderHandler(req, res) {
  try {
    const { filename, direction, newIndex } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const meta = ensureRootOrderComplete();
    meta.rootImageOrder = moveInArray(meta.rootImageOrder, String(filename), direction, typeof newIndex === 'number' ? newIndex : undefined);
    meta.rootImageOrder = Array.from(new Set(meta.rootImageOrder));
    saveRootMeta(meta);
    res.json({ ok: true, rootImageOrder: meta.rootImageOrder });
  } catch (e) {
    console.error('reorder root images error:', e);
    res.status(500).send('Failed to reorder root images');
  }
}
app.post('/gallery/images/reorder', authRole(['admin', 'mainadmin']), rootReorderHandler);
app.post('/gallery/home/images/reorder', authRole(['admin', 'mainadmin']), rootReorderHandler);

// Root images enable/disable + aliases
function rootEnableHandler(req, res) {
  try {
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const meta = loadRootMeta();
    meta.disabledRootImages = meta.disabledRootImages || {};
    if (enabled) delete meta.disabledRootImages[filename];
    else meta.disabledRootImages[filename] = true;
    saveRootMeta(meta);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('enable root image error:', e);
    res.status(500).send('Failed to update root image enabled');
  }
}
app.post('/gallery/images/enable', authRole(['admin', 'mainadmin']), rootEnableHandler);
app.post('/gallery/home/images/enable', authRole(['admin', 'mainadmin']), rootEnableHandler);

// Root image rename + aliases
function rootRenameHandler(req, res) {
  try {
    const { filename, newName } = req.body || {};
    if (!filename || !newName) return res.status(400).json({ error: 'filename and newName required' });

    const src = path.join(galleryDir, filename);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'file not found' });
    const ext = path.extname(filename).toLowerCase();
    const baseNew = slugify(String(newName).replace(path.extname(newName), ''));
    const targetName = baseNew + ext;
    const dest = path.join(galleryDir, targetName);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'target exists', filename: targetName });
    fs.renameSync(src, dest);

    const meta = loadRootMeta();
    meta.rootImageOrder = (meta.rootImageOrder || []).map(n => n === filename ? targetName : n);
    if (meta.disabledRootImages && meta.disabledRootImages[filename]) {
      delete meta.disabledRootImages[filename];
      meta.disabledRootImages[targetName] = true;
    }
    saveRootMeta(meta);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/gallery/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('rename root image error:', e);
    res.status(500).send('Failed to rename image');
  }
}
app.post('/gallery/images/rename', authRole(['admin', 'mainadmin']), rootRenameHandler);
app.post('/gallery/home/images/rename', authRole(['admin', 'mainadmin']), rootRenameHandler);

// Root image delete + aliases
function rootDeleteHandler(req, res) {
  try {
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const p = path.join(galleryDir, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
    fs.unlinkSync(p);
    const meta = loadRootMeta();
    meta.rootImageOrder = (meta.rootImageOrder || []).filter(n => n !== filename);
    if (meta.disabledRootImages) delete meta.disabledRootImages[filename];
    saveRootMeta(meta);
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('delete root image error:', e);
    res.status(500).send('Failed to delete file');
  }
}
app.delete('/gallery/images', authRole(['admin', 'mainadmin']), rootDeleteHandler);
app.delete('/gallery/home/images', authRole(['admin', 'mainadmin']), rootDeleteHandler);

/* ===================== E-Books (PDF Library with enable/disable + rename/delete) ===================== */
// Dir: /uploads/ebooks
const ebooksDir = path.join(uploadsDir, 'ebooks');
if (!fs.existsSync(ebooksDir)) fs.mkdirSync(ebooksDir, { recursive: true });
const PDF_EXT = new Set(['.pdf']);

// Meta helpers
const ebooksRootMetaPath = path.join(ebooksDir, '_meta.json');
function loadEbooksRootMeta() {
  const def = { fileOrder: [], disabledFiles: {} };
  const meta = readJSONSafe(ebooksRootMetaPath, def);
  meta.fileOrder = Array.isArray(meta.fileOrder) ? meta.fileOrder : [];
  meta.disabledFiles = meta.disabledFiles && typeof meta.disabledFiles === 'object' ? meta.disabledFiles : {};
  return meta;
}
function saveEbooksRootMeta(meta) { writeJSONSafe(ebooksRootMetaPath, meta || {}); }
function ebookFolderMetaPath(slug) { return path.join(ebooksDir, slug, 'meta.json'); }
function getEbookFolderMeta(slug) {
  const p = ebookFolderMetaPath(slug);
  const meta = readJSONSafe(p, {});
  if (!('enabled' in meta)) meta.enabled = true;
  if (!Array.isArray(meta.fileOrder)) meta.fileOrder = [];
  if (!meta.disabledFiles || typeof meta.disabledFiles !== 'object') meta.disabledFiles = {};
  return { meta, p };
}
function saveEbookFolderMeta(slug, meta) { writeJSONSafe(ebookFolderMetaPath(slug), meta); }

// Multer storages (root + per folder)
const ebookStorageRoot = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ebooksDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + (path.extname(file.originalname || '').toLowerCase() || '.pdf'));
  },
});
const uploadEbooksRoot = multer({
  storage: ebookStorageRoot,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.pdf') return cb(null, true);
    cb(new Error('Only PDF files are allowed'));
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 25 }, // 100MB per file
});
const ebookStoragePerFolder = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const slug = String(req.params.slug || '').trim();
      if (!slug) return cb(new Error('slug required'));
      const targetDir = path.join(ebooksDir, slug);
      const safeRoot = path.resolve(ebooksDir);
      const targetAbs = path.resolve(targetDir);
      if (!targetAbs.startsWith(safeRoot)) return cb(new Error('Invalid slug'));
      if (!fs.existsSync(targetAbs)) fs.mkdirSync(targetAbs, { recursive: true });
      cb(null, targetAbs);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + (path.extname(file.originalname || '').toLowerCase() || '.pdf'));
  },
});
const uploadEbooksFolder = multer({
  storage: ebookStoragePerFolder,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.pdf') return cb(null, true);
    cb(new Error('Only PDF files are allowed'));
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 25 },
});

// List folders (users/admin; users only enabled)
app.get('/ebooks/folders', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const entries = fs.readdirSync(ebooksDir, { withFileTypes: true });
    let folders = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const slug = ent.name;
      const folderPath = path.join(ebooksDir, slug);
      const { meta } = getEbookFolderMeta(slug);
      let count = 0;
      try {
        count = fs.readdirSync(folderPath, { withFileTypes: true })
          .filter(f => f.isFile() && PDF_EXT.has(path.extname(f.name).toLowerCase())).length;
      } catch (_) {}
      folders.push({
        name: meta.name || slug.replace(/-/g, ' '),
        slug,
        url: `${host}/uploads/ebooks/${slug}/`,
        fileCount: count,
        enabled: meta.enabled !== false,
      });
    }
    if (!showDisabled) folders = folders.filter(f => f.enabled !== false);
    folders.sort((a,b)=>String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
    res.json(folders);
  } catch (e) {
    console.error('ebooks folders error:', e);
    res.status(500).send('Failed to list e-book folders');
  }
});

// List root PDFs (users/admin; users only enabled)
app.get('/ebooks/files', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const meta = loadEbooksRootMeta();
    const entries = fs.readdirSync(ebooksDir, { withFileTypes: true });
    let files = entries
      .filter(ent => ent.isFile())
      .map(ent => ent.name)
      .filter(name => PDF_EXT.has(path.extname(name).toLowerCase()))
      .map(fn => {
        const st = fs.statSync(path.join(ebooksDir, fn));
        return {
          name: fn,
          url: `${host}/uploads/ebooks/${encodeURIComponent(fn)}`,
          size: st.size,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          enabled: !(meta.disabledFiles && meta.disabledFiles[fn] === true),
          order: (meta.fileOrder || []).indexOf(fn),
        };
      });
    files.sort((a,b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name)));
    if (!showDisabled) files = files.filter(x => x.enabled !== false);
    res.json(files);
  } catch (e) {
    console.error('ebooks root files error:', e);
    res.status(500).send('Failed to list e-books');
  }
});

// List PDFs inside a folder (users/admin; users only enabled)
app.get('/ebooks/folders/:slug/files', authRole(['user','admin','mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const dir = path.join(ebooksDir, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' });

    const role = req.user?.role || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';
    const includeDisabledQ = String(req.query.includeDisabled || '').toLowerCase();
    const showDisabled = isAdmin || includeDisabledQ === '1' || includeDisabledQ === 'true';

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const { meta } = getEbookFolderMeta(slug);

    let files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(ent => ent.isFile())
      .map(ent => ent.name)
      .filter(name => PDF_EXT.has(path.extname(name).toLowerCase()))
      .map(fn => {
        const st = fs.statSync(path.join(dir, fn));
        return {
          name: fn,
          url: `${host}/uploads/ebooks/${encodeURIComponent(slug)}/${encodeURIComponent(fn)}`,
          size: st.size,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          enabled: !(meta.disabledFiles && meta.disabledFiles[fn] === true),
        };
      });

    // order apply
    const idxMap = new Map((meta.fileOrder || []).map((n,i)=>[n,i]));
    files.sort((a,b)=> (idxMap.get(a.name)??1e9) - (idxMap.get(b.name)??1e9) || String(a.name).localeCompare(String(b.name)));
    if (!showDisabled) files = files.filter(x => x.enabled !== false);

    res.json(files);
  } catch (e) {
    console.error('ebooks folder files error:', e);
    res.status(500).send('Failed to list e-books in folder');
  }
});

// Admin: create folder
app.post('/ebooks/folders/create', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(String(name));
    if (!slug) return res.status(400).json({ error: 'invalid name' });
    const dir = path.join(ebooksDir, slug);
    if (fs.existsSync(dir)) return res.status(409).json({ error: 'folder already exists', slug });
    fs.mkdirSync(dir, { recursive: true });
    saveEbookFolderMeta(slug, { name: String(name).trim(), enabled: true, fileOrder: [], disabledFiles: {} });
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({ name: String(name).trim(), slug, url: `${host}/uploads/ebooks/${slug}/` });
  } catch (e) {
    console.error('ebooks create folder error:', e);
    res.status(500).send('Failed to create folder');
  }
});

// Admin: rename folder (updates meta name)
app.post('/ebooks/folders/:slug/rename', authRole(['admin','mainadmin']), (req, res) => {
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
    const { meta } = getEbookFolderMeta(newSlug);
    meta.name = desired;
    saveEbookFolderMeta(newSlug, meta);
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, slug: newSlug, name: meta.name, url: `${host}/uploads/ebooks/${newSlug}/` });
  } catch (e) {
    console.error('ebooks rename folder error:', e);
    res.status(500).send('Failed to rename folder');
  }
});

// Admin: enable/disable folder
app.post('/ebooks/folders/:slug/enable', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    const { meta } = getEbookFolderMeta(slug);
    meta.enabled = enabled;
    saveEbookFolderMeta(slug, meta);
    res.json({ ok: true, slug, enabled });
  } catch (e) {
    console.error('ebooks enable folder error:', e);
    res.status(500).send('Failed to update folder enabled');
  }
});

// Admin: delete folder
app.delete('/ebooks/folders/:slug', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const dir = path.join(ebooksDir, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true, slug });
  } catch (e) {
    console.error('ebooks delete folder error:', e);
    res.status(500).send('Failed to delete folder');
  }
});

// Admin: upload PDFs to root (updates order)
app.post('/ebooks/upload', authRole(['admin','mainadmin']), uploadEbooksRoot.array('files', 25), (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const meta = loadEbooksRootMeta();
    for (const f of files) if (!meta.fileOrder.includes(f.filename)) meta.fileOrder.push(f.filename);
    saveEbooksRootMeta(meta);

    const out = files.map(f => ({ name: f.filename, size: f.size, url: `${host}/uploads/ebooks/${encodeURIComponent(f.filename)}` }));
    res.status(201).json({ uploaded: out, count: out.length });
  } catch (e) {
    console.error('ebooks root upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Admin: upload PDFs to a folder (updates order)
app.post('/ebooks/folders/:slug/upload', authRole(['admin','mainadmin']), uploadEbooksFolder.array('files', 25), (req, res) => {
  try {
    const { slug } = req.params;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const { meta } = getEbookFolderMeta(slug);
    meta.fileOrder = Array.isArray(meta.fileOrder) ? meta.fileOrder : [];
    for (const f of files) if (!meta.fileOrder.includes(f.filename)) meta.fileOrder.push(f.filename);
    saveEbookFolderMeta(slug, meta);

    const out = files.map(f => ({ name: f.filename, size: f.size, url: `${host}/uploads/ebooks/${encodeURIComponent(slug)}/${encodeURIComponent(f.filename)}` }));
    res.status(201).json({ uploaded: out, count: out.length, folder: slug });
  } catch (e) {
    console.error('ebooks folder upload error:', e);
    res.status(500).send('Upload failed');
  }
});

// Admin: root file rename
app.post('/ebooks/files/rename', authRole(['admin','mainadmin']), (req, res) => {
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
    const meta = loadEbooksRootMeta();
    meta.fileOrder = (meta.fileOrder || []).map(n => n === filename ? targetName : n);
    if (meta.disabledFiles && meta.disabledFiles[filename]) {
      delete meta.disabledFiles[filename];
      meta.disabledFiles[targetName] = true;
    }
    saveEbooksRootMeta(meta);
    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/ebooks/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('ebooks root rename error:', e);
    res.status(500).send('Failed to rename file');
  }
});

// Admin: root file enable/disable
app.post('/ebooks/files/enable', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const meta = loadEbooksRootMeta();
    meta.disabledFiles = meta.disabledFiles || {};
    if (enabled) delete meta.disabledFiles[filename];
    else meta.disabledFiles[filename] = true;
    saveEbooksRootMeta(meta);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('ebooks root enable error:', e);
    res.status(500).send('Failed to update file enabled');
  }
});

// Admin: root file delete
app.delete('/ebooks/files', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const p = path.join(ebooksDir, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
    fs.unlinkSync(p);
    const meta = loadEbooksRootMeta();
    meta.fileOrder = (meta.fileOrder || []).filter(n => n !== filename);
    if (meta.disabledFiles) delete meta.disabledFiles[filename];
    saveEbooksRootMeta(meta);
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('ebooks root delete error:', e);
    res.status(500).send('Failed to delete file');
  }
});

// Admin: folder file rename
app.post('/ebooks/folders/:slug/files/rename', authRole(['admin','mainadmin']), (req, res) => {
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

    const { meta } = getEbookFolderMeta(slug);
    meta.fileOrder = (meta.fileOrder || []).map(n => n === filename ? targetName : n);
    if (meta.disabledFiles && meta.disabledFiles[filename]) {
      delete meta.disabledFiles[filename];
      meta.disabledFiles[targetName] = true;
    }
    saveEbookFolderMeta(slug, meta);

    const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, filename: targetName, url: `${host}/uploads/ebooks/${slug}/${encodeURIComponent(targetName)}` });
  } catch (e) {
    console.error('ebooks rename file error:', e);
    res.status(500).send('Failed to rename file');
  }
});

// Admin: folder file enable/disable
app.post('/ebooks/folders/:slug/files/enable', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const { filename } = req.body || {};
    const enabledRaw = req.body.enabled;
    const enabled = !(enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0');
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const { meta } = getEbookFolderMeta(slug);
    meta.disabledFiles = meta.disabledFiles || {};
    if (enabled) delete meta.disabledFiles[filename];
    else meta.disabledFiles[filename] = true;
    saveEbookFolderMeta(slug, meta);
    res.json({ ok: true, filename, enabled });
  } catch (e) {
    console.error('ebooks enable file error:', e);
    res.status(500).send('Failed to update file enabled');
  }
});

// Admin: folder file delete
app.delete('/ebooks/folders/:slug/files', authRole(['admin','mainadmin']), (req, res) => {
  try {
    const { slug } = req.params;
    const filename = req.query.filename || (req.body && req.body.filename);
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const p = path.join(ebooksDir, slug, filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
    fs.unlinkSync(p);

    const { meta } = getEbookFolderMeta(slug);
    meta.fileOrder = (meta.fileOrder || []).filter(n => n !== filename);
    if (meta.disabledFiles) delete meta.disabledFiles[filename];
    saveEbookFolderMeta(slug, meta);

    res.json({ ok: true, filename });
  } catch (e) {
    console.error('ebooks delete file error:', e);
    res.status(500).send('Failed to delete file');
  }
});

/* ===================== Mount analytics admin (fix 404) BEFORE general /analytics ===================== */
app.use('/analytics/admin', authRole(['admin','mainadmin']), analyticsAdminRoutes);

/* ===================== Totals (fallback) ===================== */
if (analyticsRoutes) app.use('/analytics', authRole(['user','admin','mainadmin']), analyticsRoutes);
if (totalsRoutes) {
  app.use('/totals', authRole(['user','admin','mainadmin']), totalsRoutes);
} else {
  app.get('/totals', authRole(['user','admin','mainadmin']), (req, res) => {
    try {
      const approvedDonations = (donations || []).filter(isApproved);
      const totalDonation = approvedDonations.reduce((sum, d) => sum + Number(d.amount || 0), 0);
      const approvedEnabledExpenses = (Array.isArray(expenses) ? expenses : []).filter(e => e && e.approved === true && e.enabled !== false);
      const totalExpense = approvedEnabledExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      const balance = totalDonation - totalExpense;
      res.json({ totalDonation, totalExpense, balance });
    } catch (e) {
      console.error('totals error:', e);
      res.status(500).send('Totals failed');
    }
  });
}

/* ===================== Mount existing routers ===================== */
app.use('/admin', authRole(['admin','mainadmin']), adminRoutes);
app.use('/api', categoryRoutes);

/* ===================== Debug endpoints ===================== */
app.get('/debug/donations', (req, res) => {
  try {
    const approved = (donations || []).filter(isApproved);
    res.json({
      allCount: (donations || []).length,
      approvedCount: approved.length,
      approvedSample: approved.map(d => ({
        code: d.code,
        receiptCode: d.receiptCode,
        amount: d.amount,
        category: d.category,
        approved: d.approved
      })).slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});
app.get('/debug/expenses', (req, res) => {
  try {
    res.json({ count: (expenses || []).length, sample: (expenses || []).slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: 'debug failed' });
  }
});
app.get('/debug/events', (req, res) => {
  res.json({ folders: app.locals.folders || [] });
});

// Whoami (helpful for checking token/role)
app.get('/admin/whoami', authRole(['admin','mainadmin']), (req, res) => {
  res.json(req.user);
});

/* ===================== Start server (Render compatible) ===================== */
// Health check (for monitoring)
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});