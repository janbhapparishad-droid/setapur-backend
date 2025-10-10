const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Agar data.json aapke project ke root folder me hai, to is tarah path set karein:
const dbPath = path.join(__dirname, '..', 'data.json');

function getUsers() {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const jsonData = fs.readFileSync(dbPath, 'utf-8');
  const data = JSON.parse(jsonData);
  return data.users || [];
}

function saveUsers(users) {
  users = users.map(user => {
    if (user.password) {
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(user.password, salt);
      user.passwordHash = hash;
      delete user.password;
    }
    return user;
  });

  const data = { users, gallery: [], pending: [] };
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { getUsers, saveUsers };
