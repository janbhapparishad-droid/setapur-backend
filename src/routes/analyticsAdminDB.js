const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

// Database connection setup (reuse logic from server.js to ensure consistency)
const useSSL = !!(
  (process.env.DATABASE_URL && /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(process.env.DATABASE_URL))
  || process.env.PGSSL === '1'
  || process.env.PGSSLMODE === 'require'
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

/* ======================= HELPERS ======================= */
// Ensure tables exist before doing operations
async function ensureTables() {
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
  `);
}

/* ======================= FOLDER ROUTES ======================= */

// GET /folders - List all folders with their events
router.get('/folders', async (req, res) => {
  try {
    await ensureTables();
    // Fetch folders sorted by order
    const { rows: folders } = await pool.query('SELECT * FROM analytics_folders ORDER BY order_index ASC, id ASC');
    // Fetch events sorted by order
    const { rows: events } = await pool.query('SELECT * FROM analytics_events ORDER BY order_index ASC, id ASC');

    // Combine events into their respective folders
    const result = folders.map(f => ({
      ...f,
      events: events.filter(e => e.folder_id === f.id)
    }));

    res.json(result);
  } catch (e) {
    console.error('GET /folders error:', e);
    res.status(500).send(e.message);
  }
});

// POST /folders - Create a new folder
router.post('/folders', async (req, res) => {
  try {
    await ensureTables();
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).send('Folder name is required');

    // Find next order index so new folder appears at the end
    const { rows: max } = await pool.query('SELECT MAX(order_index) as m FROM analytics_folders');
    const nextOrder = (max[0]?.m || 0) + 1;

    const { rows } = await pool.query(
      'INSERT INTO analytics_folders (name, order_index) VALUES ($1, $2) RETURNING *',
      [name.trim(), nextOrder]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /folders error:', e);
    res.status(500).send(e.message);
  }
});

// PUT /folders/:id - Rename folder
router.put('/folders/:id', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).send('New name required');

    const { rows } = await pool.query(
      'UPDATE analytics_folders SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), req.params.id]
    );
    if (!rows.length) return res.status(404).send('Folder not found');
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /folders/:id error:', e);
    res.status(500).send(e.message);
  }
});

// DELETE /folders/:id - Delete folder
router.delete('/folders/:id', async (req, res) => {
  try {
    // Because of ON DELETE CASCADE in ensureTables, this will also delete related events
    const { rows } = await pool.query('DELETE FROM analytics_folders WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).send('Folder not found');
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /folders/:id error:', e);
    res.status(500).send(e.message);
  }
});

/* ======================= EVENT ROUTES ======================= */

// POST /folders/:id/events - Add event to folder
router.post('/folders/:id/events', async (req, res) => {
  try {
    await ensureTables();
    const folderId = req.params.id;
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).send('Event name is required');

    // Verify folder exists
    const { rows: fCheck } = await pool.query('SELECT id FROM analytics_folders WHERE id=$1', [folderId]);
    if (!fCheck.length) return res.status(404).send('Folder not found');

    // Find next order index for event in this specific folder
    const { rows: max } = await pool.query('SELECT MAX(order_index) as m FROM analytics_events WHERE folder_id=$1', [folderId]);
    const nextOrder = (max[0]?.m || 0) + 1;

    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id, name, order_index, enabled, show_donation_detail, show_expense_detail) VALUES ($1, $2, $3, true, true, true) RETURNING *',
      [folderId, name.trim(), nextOrder]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST event error:', e);
    res.status(500).send(e.message);
  }
});

// PUT /folders/:fid/events/:eid - Rename event
router.put('/folders/:fid/events/:eid', async (req, res) => {
  try {
    const { fid, eid } = req.params;
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).send('New name required');

    const { rows } = await pool.query(
      'UPDATE analytics_events SET name=$1 WHERE id=$2 AND folder_id=$3 RETURNING *',
      [name.trim(), eid, fid]
    );
    if (!rows.length) return res.status(404).send('Event not found');
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT event rename error:', e);
    res.status(500).send(e.message);
  }
});

// DELETE /folders/:fid/events/:eid - Delete event
router.delete('/folders/:fid/events/:eid', async (req, res) => {
  try {
    const { fid, eid } = req.params;
    const { rows } = await pool.query(
      'DELETE FROM analytics_events WHERE id=$1 AND folder_id=$2 RETURNING *',
      [eid, fid]
    );
    if (!rows.length) return res.status(404).send('Event not found');
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE event error:', e);
    res.status(500).send(e.message);
  }
});

// PUT /folders/:fid/events/:eid/config - Update event settings (enabled, show details)
router.put('/folders/:fid/events/:eid/config', async (req, res) => {
  try {
    const { fid, eid } = req.params;
    const { enabled, showDonationDetail, showExpenseDetail } = req.body || {};

    // Dynamically build update query based on what's provided in body
    let updates = [];
    let values = [];
    let idx = 1;

    if (enabled !== undefined) { updates.push(`enabled=$${idx++}`); values.push(enabled); }
    if (showDonationDetail !== undefined) { updates.push(`show_donation_detail=$${idx++}`); values.push(showDonationDetail); }
    if (showExpenseDetail !== undefined) { updates.push(`show_expense_detail=$${idx++}`); values.push(showExpenseDetail); }

    if (updates.length === 0) return res.status(400).send('Nothing to update');

    values.push(eid, fid);
    const sql = `UPDATE analytics_events SET ${updates.join(', ')} WHERE id=$${idx++} AND folder_id=$${idx++} RETURNING *`;

    const { rows } = await pool.query(sql, values);
    if (!rows.length) return res.status(404).send('Event not found');
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT event config error:', e);
    res.status(500).send(e.message);
  }
});

module.exports = router;