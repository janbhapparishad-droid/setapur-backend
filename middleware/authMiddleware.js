// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const { getUsers } = require('../models/jsonDb');

const SECRET_KEY = process.env.JWT_SECRET || 'your_secret_key_here';

// Verifies token and attaches req.user
function verifyToken(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header) return res.status(401).send('Access Denied');

  try {
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const decoded = jwt.verify(token, SECRET_KEY); // { id, username, role }
    req.user = decoded;

    // Optional: block banned users if you use jsonDb users
    try {
      const users = getUsers();
      const found = users.find(u => u.username === req.user.username);
      if (found?.banned) return res.status(403).send('User banned');
    } catch (_) {}

    next();
  } catch (err) {
    return res.status(400).send('Invalid Token');
  }
}

// Enforce roles (string or array). Supports 'any'.
function authRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user?.role) return res.status(401).send('Unauthorized');
    if (allowed.includes('any')) return next();
    if (!allowed.includes(req.user.role)) return res.status(403).send('Forbidden');
    next();
  };
}

module.exports = { verifyToken, authRole };