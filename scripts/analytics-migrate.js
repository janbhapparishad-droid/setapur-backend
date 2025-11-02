const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Error: DATABASE_URL not set.");
  process.exit(0); // do not fail deploy
}

const useSSL = /sslmode=require|render|neon|amazonaws|\.neon\.tech/i.test(connectionString)
            || /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || "");
const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const client = await pool.connect();
  const q = (text, params) => client.query(text, params);

  async function safe(label, sql, params) {
    try { await q(sql, params); console.log("✓", label); }
    catch (e) { console.warn("~", label, "-", e.message); }
  }
  async function colExists(table, column) {
    const { rows } = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, column]
    );
    return rows.length > 0;
  }
  async function getColumn(table, column) {
    const { rows } = await q(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, column]
    );
    return rows[0] || null;
  }
  async function funcExists(name) {
    const { rows } = await q(
      `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = $1) AS ok`,
      [name]
    );
    return !!rows[0]?.ok;
  }
  function qi(ident) { return '"' + String(ident).replace(/"/g, '""') + '"'; }

  async function dropFksOnColumn(table, column) {
    const sql = `
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_name = tc.table_name
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = $2`;
    try {
      const { rows } = await q(sql, [table, column]);
      for (const r of rows) {
        const name = r.constraint_name;
        await safe(`drop FK ${table}.${name}`, `ALTER TABLE ${table} DROP CONSTRAINT ${qi(name)}`);
      }
    } catch (e) { console.warn("~ fk introspection", e.message); }
  }

  try {
    // Folders table and columns
    await safe("create analytics_folders",
      `CREATE TABLE IF NOT EXISTS analytics_folders (
        id SERIAL PRIMARY KEY,
        name TEXT,
        slug TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
    await safe("folders add name",       `ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS name TEXT`);
    await safe("folders add slug",       `ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS slug TEXT`);
    await safe("folders add enabled",    `ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await safe("folders add order_index",`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0`);
    await safe("folders add created_at", `ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);
    await safe("folders backfill name",  `UPDATE analytics_folders SET name = COALESCE(name, slug, 'Group-'||id::text) WHERE name IS NULL`);
    await safe("folders name NOT NULL",  `ALTER TABLE analytics_folders ALTER COLUMN name SET NOT NULL`);
    if (await colExists('analytics_folders','sort')) {
      await safe("folders copy sort->order_index",
        `UPDATE analytics_folders SET order_index = sort WHERE (order_index IS NULL OR order_index = 0) AND sort IS NOT NULL`);
    }

    // Legacy folder_id handling
    if (await colExists('analytics_folders', 'folder_id')) {
      // Try enabling extensions (best-effort)
      await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await safe(`ext uuid-ossp`, `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

      const hasGenRandom = await funcExists('gen_random_uuid');
      const hasUuidV4   = await funcExists('uuid_generate_v4');
      const gen = hasGenRandom ? 'gen_random_uuid()' : (hasUuidV4 ? 'uuid_generate_v4()' : null);
      const col = await getColumn('analytics_folders','folder_id');

      if (gen && col) {
        if (col.data_type === 'uuid') {
          await safe("folders folder_id default (uuid)", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ${gen}`);
          await safe("folders folder_id backfill (uuid)", `UPDATE analytics_folders SET folder_id = ${gen} WHERE folder_id IS NULL`);
        } else {
          await safe("folders folder_id default (text)", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (${gen})::text`);
          await safe("folders folder_id backfill (text)", `UPDATE analytics_folders SET folder_id = (${gen})::text WHERE folder_id IS NULL`);
        }
      } else if (col && col.is_nullable === 'NO') {
        await safe("folders folder_id drop NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL`);
      }
    }

    // Events table and columns
    await safe("create analytics_events",
      `CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        folder_id INT,
        name TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        show_donation_detail BOOLEAN DEFAULT TRUE,
        show_expense_detail BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
    await safe("events add folder_id",          `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS folder_id INT`);
    await safe("events add name",               `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS name TEXT`);
    await safe("events add enabled",            `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await safe("events add show_donation",      `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE`);
    await safe("events add show_expense",       `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE`);
    await safe("events add order_index",        `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0`);
    await safe("events add created_at",         `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

    // Ensure folder_id integer + FK
    const evCol = await getColumn('analytics_events','folder_id');
    if (evCol && evCol.data_type !== 'integer') {
      await dropFksOnColumn('analytics_events','folder_id');
      await safe("events folder_id to integer", `ALTER TABLE analytics_events ALTER COLUMN folder_id TYPE integer USING NULL::integer`);
    }
    await safe("events fk -> folders",
      `ALTER TABLE analytics_events
         ADD CONSTRAINT fk_analytics_events_folder
         FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID`);

    // Indexes
    await safe("idx folders order", `CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))`);
    await safe("idx events folder", `CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)`);
    await safe("idx events order",  `CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)`);

    console.log("✅ Analytics schema safe migration finished.");
  } catch (e) {
    console.warn("~ Migration encountered an error:", e.message);
  } finally {
    client.release();
    await pool.end();
  }
})();
