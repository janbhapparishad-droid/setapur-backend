// models/jsonDb.js (Postgres-backed)
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Neon URL
  ssl: { require: true, rejectUnauthorized: false },
});

let ensured = false;
async function ensure() {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      full_name TEXT,
      display_name TEXT,
      logged_in TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  ensured = true;
}

function rowToUser(r) {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    role: r.role,
    banned: r.banned,
    name: r.name || null,
    fullName: r.full_name || null,
    displayName: r.display_name || null,
    loggedIn: r.logged_in || null,
    createdAt: r.created_at,
  };
}

// Ab yeh async hai
async function getUsers() {
  await ensure();
  const { rows } = await pool.query(`
    SELECT id, username, password_hash, role, banned, name, full_name, display_name, logged_in, created_at
    FROM users ORDER BY id ASC
  `);
  return rows.map(rowToUser);
}

// Poora array upsert karta hai (DELETE nahi karta)
async function saveUsers(users) {
  await ensure();
  if (!Array.isArray(users)) return;

  for (const u of users) {
    let passwordHash = u.passwordHash || null;

    if (u.password && String(u.password).trim()) {
      const hash = bcrypt.hashSync(u.password, 10);
      passwordHash = hash;
      delete u.password;
    }

    await pool.query(
      `INSERT INTO users (username, password_hash, role, banned, name, full_name, display_name, logged_in)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         role = EXCLUDED.role,
         banned = EXCLUDED.banned,
         name = EXCLUDED.name,
         full_name = EXCLUDED.full_name,
         display_name = EXCLUDED.display_name,
         logged_in = EXCLUDED.logged_in`,
      [
        u.username,
        passwordHash,
        String(u.role || 'user'),
        !!u.banned,
        u.name || null,
        u.fullName || null,
        u.displayName || null,
        u.loggedIn || null,
      ]
    );
  }
}

module.exports = { getUsers, saveUsers };