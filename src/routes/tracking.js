const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const useSSL = !!(
  (process.env.DATABASE_URL && /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(process.env.DATABASE_URL))
  || process.env.PGSSL === '1'
  || process.env.PGSSLMODE === 'require'
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Admin authentication middleware placeholder
const authRole = (roles) => {
  return (req, res, next) => {
    const userRole = req.user ? req.user.role : null;
    if (roles.includes(userRole)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
};

/* ======================= INIT TABLES ======================= */
async function ensureTrackingTables() {
  // Add last_login_at and last_active_at to users table if not exists
  try { await pool.query('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ'); } catch (e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN last_active_at TIMESTAMPTZ'); } catch (e) {}
  
  await pool.query(
    CREATE TABLE IF NOT EXISTS app_events (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      device_id TEXT,
      event_type TEXT NOT NULL,
      target TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  );
}
ensureTrackingTables().catch(console.error);

/* ======================= USER APP ROUTES ======================= */

// Heartbeat ping from user app
router.post('/heartbeat', async (req, res) => {
  try {
    const { userId, deviceId } = req.body;
    if (userId) {
      await pool.query('UPDATE users SET last_active_at = now() WHERE id = \', [userId]);
    }
    // Could also track active devices here if needed
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single event tracking
router.post('/event', async (req, res) => {
  try {
    const { userId, deviceId, eventType, target, metadata } = req.body;
    await pool.query(
      'INSERT INTO app_events (user_id, device_id, event_type, target, metadata) VALUES (\, \, \, \, \)',
      [userId || null, deviceId, eventType, target, metadata ? JSON.stringify(metadata) : null]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch event tracking
router.post('/events/batch', async (req, res) => {
  try {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) return res.status(400).json({ error: 'events must be an array' });

    for (const ev of events) {
      await pool.query(
        'INSERT INTO app_events (user_id, device_id, event_type, target, metadata, created_at) VALUES (\, \, \, \, \, \)',
        [ev.userId || null, ev.deviceId, ev.eventType, ev.target, ev.metadata ? JSON.stringify(ev.metadata) : null, ev.timestamp || new Date()]
      );
    }
    res.json({ success: true, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
