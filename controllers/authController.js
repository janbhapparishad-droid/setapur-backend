const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../models/User');
const SECRET_KEY = 'your_secret_key_here';

exports.createUser = async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res.status(400).send('Missing fields');
  if (users.find(u => u.username === username))
    return res.status(400).send('User exists');

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  users.push({ id: users.length + 1, username, passwordHash, role, banned: false, loggedInDevice: null });
  res.send('User created successfully');
};

exports.login = async (req, res) => {
  const { username, password, deviceId } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).send('User not found');
  if (user.banned) return res.status(403).send('User banned');

  const validPass = await bcrypt.compare(password, user.passwordHash);
  if (!validPass) return res.status(400).send('Invalid password');

  // Single device login enforcement
  if (user.loggedInDevice && user.loggedInDevice !== deviceId) {
    user.loggedInDevice = deviceId; // Override existing session
  } else {
    user.loggedInDevice = deviceId;
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET_KEY,
    { expiresIn: '8h' }
  );
  res.json({ token });
};
