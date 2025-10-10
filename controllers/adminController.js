const users = require('../models/User');

exports.getUsers = (req, res) => {
  res.json(users);
};

exports.banUser = (req, res) => {
  const { username, ban } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(404).send('User not found');
  user.banned = ban;
  if (ban) user.loggedInDevice = null;
  res.send(`User ${ban ? 'banned' : 'unbanned'} successfully`);
};
