// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { getUsers, saveUsers } = require('../models/jsonDb');
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
  const { username, password, role } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).send('Username, password and role required');
  }

  const users = getUsers();
  const uname = String(username).trim();
  if (users.find(u => String(u.username).trim() === uname)) {
    return res.status(400).send('User already exists');
  }

  const nextId = users.length ? Math.max(...users.map(u => Number(u.id) || 0)) + 1 : 1;
  const newUser = {
    id: nextId,
    username: uname,
    password: String(password), // saveUsers() will hash the password
    role: String(role).trim().toLowerCase(), // store lower-case
    banned: false,
  };

  users.push(newUser);
  saveUsers(users);
  res.status(201).json({ message: 'User created successfully' });
});

// Get all users (safe list)
router.get('/users', requireMainAdmin, (req, res) => {
  const users = getUsers();
  const userList = users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    banned: !!u.banned
  }));
  res.json(userList);
});

// Ban/unban user
router.post('/ban-user', requireMainAdmin, (req, res) => {
  const { userId, ban } = req.body || {};
  const users = getUsers();
  const user = users.find(u => String(u.id) === String(userId));
  if (!user) return res.status(404).send('User not found');

  user.banned = ban === true || ban === 'true' || ban === 1 || ban === '1';
  saveUsers(users);
  res.json({ message: `User ${user.banned ? 'banned' : 'unbanned'} successfully` });
});

// Donations admin
router.post('/approve-donation', requireMainAdmin, approveDonation);
router.get('/donations', requireMainAdmin, getAllDonations);

module.exports = router;