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

/* ======================= ADMIN TRACKING ROUTES ======================= */

// Get Dashboard Summary Stats
router.get('/dashboard', async (req, res) => {
  try {
    // Online users (active in last 5 mins)
    const { rows: onlineRes } = await pool.query("SELECT COUNT(*) FROM users WHERE last_active_at > now() - interval '5 minutes'");
    // Total users
    const { rows: totalUsersRes } = await pool.query("SELECT COUNT(*) FROM users");
    // Unique devices active in last 30 days (approximation of active installs)
    const { rows: installsRes } = await pool.query("SELECT COUNT(DISTINCT device_id) FROM app_events WHERE created_at > now() - interval '30 days'");

    res.json({
      onlineUsers: parseInt(onlineRes[0].count),
      totalUsers: parseInt(totalUsersRes[0].count),
      activeInstalls: parseInt(installsRes[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Users List with Status
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      SELECT 
        u.id, 
        u.username, 
        u.last_login_at, 
        u.last_active_at,
        CASE WHEN u.last_active_at > now() - interval '5 minutes' THEN true ELSE false END as is_online,
        (SELECT COUNT(*) FROM app_events WHERE user_id = u.id) as total_events
      FROM users u
      ORDER BY u.last_active_at DESC NULLS LAST
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Specific User's Timeline
router.get('/user-activity/:userId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const { rows } = await pool.query(
      SELECT id, event_type, target, metadata, created_at 
      FROM app_events 
      WHERE user_id = \ 
      ORDER BY created_at DESC 
      LIMIT \
    , [req.params.userId, limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
