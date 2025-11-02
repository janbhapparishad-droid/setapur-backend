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
  await pool.query(
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
  );
}

async function resolveEvent(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    try {
      const { rows } = await pool.query('SELECT id,name,enabled,show_donation_detail,show_expense_detail,folder_id FROM analytics_events WHERE id=', [Number(s)]);
      if (rows.length) return rows[0];
    } catch (_) {}
  }
  try {
    const { rows } = await pool.query('SELECT id,name,enabled,show_donation_detail,show_expense_detail,folder_id FROM analytics_events WHERE lower(name)=lower() LIMIT 1', [s]);
    if (rows.length) return rows[0];
  } catch (_){}
  return null;
}

const router = express.Router();

/* Public: list enabled events in enabled folders (for user app) */
router.get('/events', async (req, res) => {
  try {
    await ensure();
    const q = (req.query.q || '').toString().trim();
    let sql = 
      SELECT e.id, e.name, e.enabled, e.show_donation_detail, e.show_expense_detail, e.order_index,
             f.id AS folder_id, f.name AS folder_name, f.slug AS folder_slug, f.order_index AS folder_order
      FROM analytics_events e
      JOIN analytics_folders f ON f.id = e.folder_id
      WHERE f.enabled = true AND e.enabled = true
    ;
    const vals = [];
    if (q) { sql += ' AND (lower(e.name) LIKE lower() OR lower(f.name) LIKE lower())'; vals.push('%' + q + '%'); }
    sql += ' ORDER BY f.order_index ASC, e.order_index ASC, lower(e.name) ASC';

    const { rows } = await pool.query(sql, vals);
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      showDonationDetail: r.show_donation_detail,
      showExpenseDetail: r.show_expense_detail,
      orderIndex: r.order_index,
      folder: { id: r.folder_id, name: r.folder_name, slug: r.folder_slug, orderIndex: r.folder_order }
    })));
  } catch (e) {
    console.error('public events list error:', e);
    res.status(500).send('Failed to load events');
  }
});

/* Helpers to gate visibility: for user endpoints, respect event flags */
function canShowDonations(ev, role) {
  if (role === 'admin' || role === 'mainadmin') return true;
  return ev.enabled !== false && ev.show_donation_detail !== false;
}
function canShowExpenses(ev, role) {
  if (role === 'admin' || role === 'mainadmin') return true;
  return ev.enabled !== false && ev.show_expense_detail !== false;
}

/* Public: event donations (gift excluded) */
router.get('/events/:eventId/donations', async (req, res) => {
  try {
    await ensure();
    const ev = await resolveEvent(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const role = (req.user && req.user.role) || 'user';
    if (!canShowDonations(ev, role)) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const sql = 
      SELECT id, donor_name, amount, payment_method, receipt_code, created_at, category, approved, status
      FROM donations
      WHERE approved = true
        AND lower(category) = lower()
        AND lower(coalesce(payment_method,'')) <> 'gift'
      ORDER BY created_at DESC
      LIMIT  OFFSET 
    ;
    const { rows } = await pool.query(sql, [ev.name, limit, offset]);
    res.json(rows.map(r => ({
      id: r.id,
      donorName: r.donor_name,
      amount: Number(r.amount),
      paymentMethod: r.payment_method,
      receiptCode: r.receipt_code,
      createdAt: r.created_at,
      category: r.category
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
    const role = (req.user && req.user.role) || 'user';
    if (!canShowDonations(ev, role)) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const sql = 
      SELECT id, donor_name, amount, payment_method, receipt_code, created_at, category, approved, status
      FROM donations
      WHERE approved = true
        AND lower(category) = lower()
        AND lower(coalesce(payment_method,'')) = 'gift'
      ORDER BY created_at DESC
      LIMIT  OFFSET 
    ;
    const { rows } = await pool.query(sql, [ev.name, limit, offset]);
    res.json(rows.map(r => ({
      id: r.id,
      donorName: r.donor_name,
      amount: Number(r.amount),
      receiptCode: r.receipt_code,
      createdAt: r.created_at,
      category: r.category
    })));
  } catch (e) {
    console.error('public event gifts error:', e);
    res.status(500).send('Failed to load gifts');
  }
});

/* Public: event expenses */
router.get('/events/:eventId/expenses', async (req, res) => {
  try {
    await ensure();
    const ev = await resolveEvent(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const role = (req.user && req.user.role) || 'user';
    if (!canShowExpenses(ev, role)) return res.status(403).json({ error: 'Hidden' });

    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const sql = 
      SELECT id, amount, description, paid_to, date, created_at, category
      FROM expenses
      WHERE approved = true
        AND enabled = true
        AND lower(category) = lower()
      ORDER BY COALESCE(date, created_at) DESC
      LIMIT  OFFSET 
    ;
    const { rows } = await pool.query(sql, [ev.name, limit, offset]);
    res.json(rows.map(r => ({
      id: r.id,
      amount: Number(r.amount),
      description: r.description,
      paidTo: r.paid_to,
      date: r.date,
      createdAt: r.created_at,
      category: r.category
    })));
  } catch (e) {
    console.error('public event expenses error:', e);
    res.status(500).send('Failed to load expenses');
  }
});

module.exports = router;
