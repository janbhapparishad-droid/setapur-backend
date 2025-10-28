// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { getUsers, saveUsers } = require('../models/jsonDb'); // async (PG-backed)
const { approveDonation, getAllDonations } = require('../controllers/donationController');

// Role normalize: "Main Admin" / "main-admin" => "mainadmin"
function normRole(r) {
  return String(r || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// Only mainadmin allowed
function requireMainAdmin(req, res, next) {
  const role = normRole(req.user && req.user.role);
  if (role !== 'mainadmin') {
    return res.status(403).send('Access denied. mainadmin role required.');
  }
  next();
}

// Create new user
router.post('/create-user', requireMainAdmin, async (req, res) => {
  try {
    // Support FE sending "id" as username fallback
    const usernameRaw = req.body?.username ?? req.body?.id;
    const username = String(usernameRaw || '').trim();
    const password = String(req.body?.password || '');
    let role = normRole(req.body?.role || 'user');

    if (!username || !password) {
      return res.status(400).send('Username and password required');
    }
    if (!['user', 'admin', 'mainadmin'].includes(role)) role = 'user';

    const users = await getUsers();
    const current = Array.isArray(users) ? users : [];
    const exists = current.find(
      u => String(u.username || '').toLowerCase() === username.toLowerCase()
    );
    if (exists) return res.status(400).send('User already exists');

    // saveUsers will hash password and upsert by username
    const next = current.slice();
    next.push({ username, password, role, banned: false });
    await saveUsers(next);

    // Return created user info (with id)
    const after = await getUsers();
    const created = (Array.isArray(after) ? after : []).find(
      u => String(u.username || '').toLowerCase() === username.toLowerCase()
    );

    return res.status(201).json({
      message: 'User created successfully',
      user: created
        ? { id: created.id, username: created.username, role: created.role, banned: !!created.banned }
        : { username, role }
    });
  } catch (e) {
    console.error('create-user error:', e);
    return res.status(500).send('Create user failed');
  }
});

// Get all users (safe list)
router.get('/users', requireMainAdmin, async (req, res) => {
  try {
    const users = await getUsers();
    const list = (Array.isArray(users) ? users : []).map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      banned: !!u.banned
    }));
    res.json(list);
  } catch (e) {
    console.error('list users error:', e);
    res.status(500).send('List users failed');
  }
});

// Ban/unban user
router.post('/ban-user', requireMainAdmin, async (req, res) => {
  try {
    const { userId, ban } = req.body || {};
    const users = await getUsers();
    const current = Array.isArray(users) ? users : [];

    // Allow ban by numeric id OR username string
    const idx = current.findIndex(
      u =>
        String(u.id) === String(userId) ||
        String(u.username || '').toLowerCase() === String(userId || '').toLowerCase()
    );
    if (idx === -1) return res.status(404).send('User not found');

    const shouldBan = ban === true || ban === 'true' || ban === 1 || ban === '1';
    current[idx].banned = shouldBan;

    await saveUsers(current);
    res.json({ message: `User ${shouldBan ? 'banned' : 'unbanned'} successfully` });
  } catch (e) {
    console.error('ban-user error:', e);
    res.status(500).send('Ban user failed');
  }
});

// Donations admin
router.post('/approve-donation', requireMainAdmin, approveDonation);
router.get('/donations', requireMainAdmin, getAllDonations);

module.exports = router;