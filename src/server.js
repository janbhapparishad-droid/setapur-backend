"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    (process.env.NODE_ENV === "production" ||
      String(process.env.DATABASE_SSL || "true").toLowerCase() === "true")
      ? { rejectUnauthorized: false }
      : false,
});

async function ensureCategoriesTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS categories (" +
      "id SERIAL PRIMARY KEY," +
      "name TEXT UNIQUE NOT NULL," +
      "enabled BOOLEAN NOT NULL DEFAULT TRUE," +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ")"
  );
}

const JWT_SECRET = process.env.JWT_SECRET || "devsecret";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Admin@123";

function authRole(roles) {
  return function (req, res, next) {
    const h = req.headers["authorization"] || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: "missing token" });
    try {
      const payload = jwt.verify(tok, JWT_SECRET);
      if (roles && roles.length && roles.indexOf(payload.role) === -1) {
        return res.status(403).json({ error: "forbidden" });
      }
      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: "invalid token" });
    }
  };
}

// Health
app.get("/health", function (req, res) {
  res.send("ok");
});

// Minimal admin login (ADMIN_USER/ADMIN_PASS env vars; default admin/Admin@123)
app.post("/auth/login", async function (req, res) {
  try {
    const username = (req.body && req.body.username) ? String(req.body.username) : "";
    const password = (req.body && req.body.password) ? String(req.body.password) : "";
    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = jwt.sign(
      { id: 1, username: username, role: "mainadmin" },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token: token });
  } catch (e) {
    res.status(500).json({ error: "login failed" });
  }
});

// Admin list (all)
app.get("/api/categories/list", authRole(["admin", "mainadmin"]), async function (req, res) {
  try {
    await ensureCategoriesTable();
    const { rows } = await pool.query(
      "SELECT id, name, enabled, created_at FROM categories ORDER BY id ASC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "list failed" });
  }
});

// Public (enabled-only)
app.get("/public/categories", async function (req, res) {
  try {
    await ensureCategoriesTable();
    const { rows } = await pool.query(
      "SELECT id, name FROM categories WHERE enabled = TRUE ORDER BY id ASC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "public list failed" });
  }
});

// Create category
app.post("/api/admin/categories", authRole(["admin", "mainadmin"]), async function (req, res) {
  try {
    await ensureCategoriesTable();
    const nm = (req.body && req.body.name) ? String(req.body.name).trim() : "";
    if (!nm) return res.status(400).json({ error: "name required" });

    const dup = await pool.query(
      "SELECT 1 FROM categories WHERE lower(name)=lower($1) LIMIT 1",
      [nm]
    );
    if (dup.rows.length) return res.status(409).json({ error: "category already exists" });

    const ins = await pool.query(
      "INSERT INTO categories (name, enabled) VALUES ($1, TRUE) RETURNING id, name, enabled, created_at",
      [nm]
    );
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "create failed" });
  }
});

// Update (rename/enable)
app.put("/api/admin/categories/:id", authRole(["admin", "mainadmin"]), async function (req, res) {
  try {
    await ensureCategoriesTable();
    const id = req.params.id;

    const nameIn =
      (req.body && (req.body.name || req.body.newName))
        ? String(req.body.name || req.body.newName).trim()
        : undefined;

    const enabledInRaw = req.body
      ? (req.body.enabled !== undefined
          ? req.body.enabled
          : req.body.enable !== undefined
          ? req.body.enable
          : req.body.isEnabled !== undefined
          ? req.body.isEnabled
          : req.body.status !== undefined
          ? req.body.status
          : undefined)
      : undefined;

    let enabledParsed = undefined;
    if (enabledInRaw !== undefined) {
      if (typeof enabledInRaw === "boolean") enabledParsed = enabledInRaw;
      else {
        const s = String(enabledInRaw).toLowerCase().trim();
        if (["1", "true", "yes", "on", "enabled", "active"].includes(s)) enabledParsed = true;
        else if (["0", "false", "no", "off", "disabled", "inactive"].includes(s)) enabledParsed = false;
      }
    }

    const fields = [];
    const vals = [];
    let idx = 1;

    if (nameIn !== undefined) {
      if (!nameIn) return res.status(400).json({ error: "name (or newName) required" });
      fields.push("name = $" + (idx++)); vals.push(nameIn);
    }
    if (enabledParsed !== undefined) {
      fields.push("enabled = $" + (idx++)); vals.push(enabledParsed);
    }
    if (!fields.length) return res.status(400).json({ error: "send name or enabled" });

    vals.push(id);
    const sql =
      "UPDATE categories SET " + fields.join(", ") +
      " WHERE id=$" + idx + " RETURNING id, name, enabled, created_at";
    const q = await pool.query(sql, vals);
    if (!q.rows.length) return res.status(404).json({ error: "category not found" });
    res.json({ ok: true, category: q.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "update failed" });
  }
});

// Delete
app.delete("/api/categories/:id", authRole(["admin", "mainadmin"]), async function (req, res) {
  try {
    await ensureCategoriesTable();
    const id = req.params.id;
    const del = await pool.query(
      "DELETE FROM categories WHERE id=$1 RETURNING id, name, enabled, created_at",
      [id]
    );
    if (!del.rows.length) return res.status(404).json({ error: "category not found" });
    res.json({ ok: true, category: del.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "delete failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, function () {
  console.log("Categories server listening on " + PORT);
});