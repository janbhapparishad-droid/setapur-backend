const express = require('express');
const { Pool } = require('pg');

const useSSL =
  /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(process.env.DATABASE_URL || '') ||
  /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

async function ensure() {
  await pool.query('CREATE TABLE IF NOT EXISTS analytics_folders (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT, enabled BOOLEAN DEFAULT TRUE, order_index INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())');
  await pool.query('CREATE TABLE IF NOT EXISTS analytics_events (id SERIAL PRIMARY KEY, folder_id INT REFERENCES analytics_folders(id) ON DELETE CASCADE, name TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, show_donation_detail BOOLEAN DEFAULT TRUE, show_expense_detail BOOLEAN DEFAULT TRUE, order_index INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)');
}

async function resolveEvent(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    try {
      const r = await pool.query('SELECT id,name,enabled,show_donation_detail,show_expense_detail,folder_id FROM analytics_events WHERE id=$1', [Number(s)]);
      if (r.rows.length) return r.rows[0];
    } catch (_) {}
  }
  try {
    const r = await pool.query('SELECT id,name,enabled,show_donation_detail,show_expense_detail,folder_id FROM analytics_events WHERE lower(name)=lower($1) LIMIT 1', [s]);
    if (r.rows.length) return r.rows[0];
  } catch (_){}
  return null;
}

const router = express.Router();

/* Public: list enabled events in enabled folders (for user app) */
router.get('/events', async (req, res) => {
  try {
    await ensure();
    const q = (req.query.q || '').toString().trim();
    let sql = 'SELECT e.id, e.name, e.enabled, e.show_donation_detail, e.show_expense_detail, e.order_index, f.id AS folder_id, f.name AS folder_name, f.slug AS folder_slug, f.order_index AS folder_order FROM analytics_events e JOIN analytics_folders f ON f.id = e.folder_id WHERE f.enabled = true AND e.enabled = true';
    const vals = [];
    if (q) { sql += ' AND (lower(e.name) LIKE lower($1) OR lower(f.name) LIKE lower($1))'; vals.push('%' + q + '%'); }
    sql += ' ORDER BY f.order_index ASC, e.order_index ASC, lower(e.name) ASC';

    const r = await pool.query(sql, vals);
    res.json(r.rows.map(x => ({
      id: x.id,
      name: x.name,
      enabled: x.enabled,
      showDonationDetail: x.show_donation_detail,
      showExpenseDetail: x.show_expense_detail,
      orderIndex: x.order_index,
      folder: { id: x.folder_id, name: x.folder_name, slug: x.folder_slug, orderIndex: x.folder_order }
    })));
  } catch (e) {
    console.error('public events list error:', e);
    res.status(500).send('Failed to load events');
  }
});

function roleOf(req){ return (req.user && req.user.role) || 'user'; }
function canShowDonations(ev, role){ return (role==='admin'||role==='mainadmin') ? true : (ev.enabled !== false && ev.show_donation_detail !== false); }
function canShowExpenses(ev, role){ return (role==='admin'||role==='mainadmin') ? true : (ev.enabled !== false && ev.show_expense_detail !== false); }

/* Public: event donations (gift excluded) */
router.get('/events/:eventId/donations', async (req, res) => {
  try {
    await ensure();
    const ev = await resolveEvent(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (!canShowDonations(ev, roleOf(req))) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const sql = 'SELECT id, donor_name, amount, payment_method, receipt_code, created_at, category, approved, status FROM donations WHERE approved = true AND lower(category) = lower($1) AND lower(coalesce(payment_method,\'\')) <> \'gift\' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    const r = await pool.query(sql, [ev.name, limit, offset]);
    res.json(r.rows.map(d => ({
      id: d.id, donorName: d.donor_name, amount: Number(d.amount), paymentMethod: d.payment_method,
      receiptCode: d.receipt_code, createdAt: d.created_at, category: d.category
    })));
  } catch (e) {
    console.error('public event donations error:', e);
    res.status(500).send('Failed to load donations');
  }
});

/* Public: event gifts (payment_method = gift) */
router.get('/events/:eventId/gifts', async (req, res) => {
  try {
    await ensure();
    const ev = await resolveEvent(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (!canShowDonations(ev, roleOf(req))) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const sql = 'SELECT id, donor_name, amount, payment_method, receipt_code, created_at, category, approved, status FROM donations WHERE approved = true AND lower(category) = lower($1) AND lower(coalesce(payment_method,\'\')) = \'gift\' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    const r = await pool.query(sql, [ev.name, limit, offset]);
    res.json(r.rows.map(d => ({
      id: d.id, donorName: d.donor_name, amount: Number(d.amount), receiptCode: d.receipt_code, createdAt: d.created_at, category: d.category
    })));
  } catch (e) {
    console.error('public event gifts error:', e);
    res.status(500).send('Failed to load gifts');
  }
});

/* Public: event expenses (approved+enabled) */
router.get('/events/:eventId/expenses', async (req, res) => {
  try {
    await ensure();
    const ev = await resolveEvent(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (!canShowExpenses(ev, roleOf(req))) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const sql = 'SELECT id, amount, description, paid_to, date, created_at, category FROM expenses WHERE approved = true AND enabled = true AND lower(category) = lower($1) ORDER BY COALESCE(date, created_at) DESC LIMIT $2 OFFSET $3';
    const r = await pool.query(sql, [ev.name, limit, offset]);
    res.json(r.rows.map(x => ({
      id: x.id, amount: Number(x.amount), description: x.description, paidTo: x.paid_to, date: x.date, createdAt: x.created_at, category: x.category
    })));
  } catch (e) {
    console.error('public event expenses error:', e);
    res.status(500).send('Failed to load expenses');
  }
});

module.exports = router;
