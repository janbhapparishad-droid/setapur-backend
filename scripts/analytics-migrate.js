const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Error: DATABASE_URL not set.");
  process.exit(1);
}

const useSSL = /sslmode=require|render|neon|amazonaws|\.neon\.tech/i.test(connectionString)
            || /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || "");
const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

async function run() {
  const client = await pool.connect();
  const q = (text, params) => client.query(text, params);

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
  function qi(ident) { return '"' + String(ident).replace(/"/g, '""') + '"'; } // quote identifier

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
    const { rows } = await q(sql, [table, column]);
    for (const r of rows) {
      const name = r.constraint_name;
      try { await q(`ALTER TABLE ${table} DROP CONSTRAINT ${qi(name)}`); }
      catch (e) { /* ignore */ }
    }
  }

  try {
    await q('BEGIN');

    // Ensure analytics_folders table exists (with minimal cols; we will add/alter below)
    await q(`
      CREATE TABLE IF NOT EXISTS analytics_folders (
        id SERIAL PRIMARY KEY,
        name TEXT,
        slug TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);

    // Ensure required columns exist (idempotent)
    await q(`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS name TEXT`);
    await q(`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS slug TEXT`);
    await q(`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await q(`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0`);
    await q(`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

    // Backfill name if missing, then enforce NOT NULL
    await q(`UPDATE analytics_folders SET name = COALESCE(name, slug, 'Group-'||id::text) WHERE name IS NULL`);
    await q(`ALTER TABLE analytics_folders ALTER COLUMN name SET NOT NULL`);

    // If legacy "sort" exists, copy it into order_index where empty
    if (await colExists('analytics_folders', 'sort')) {
      await q(`UPDATE analytics_folders SET order_index = sort WHERE (order_index IS NULL OR order_index = 0) AND sort IS NOT NULL`);
    }

    // Handle legacy folder_id (NOT NULL error source)
    if (await colExists('analytics_folders', 'folder_id')) {
      const col = await getColumn('analytics_folders', 'folder_id');

      // Try to create extensions (best-effort)
      try { await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`); } catch(_) {}
      try { await q(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`); } catch(_) {}

      const hasGenRandom = await funcExists('gen_random_uuid');
      const hasUuidV4 = await funcExists('uuid_generate_v4');
      const gen = hasGenRandom ? 'gen_random_uuid()' : (hasUuidV4 ? 'uuid_generate_v4()' : null);

      if (gen) {
        if (col.data_type === 'uuid') {
          await q(`ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ${gen}`);
          await q(`UPDATE analytics_folders SET folder_id = ${gen} WHERE folder_id IS NULL`);
        } else {
          await q(`ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (${gen})::text`);
          await q(`UPDATE analytics_folders SET folder_id = (${gen})::text WHERE folder_id IS NULL`);
        }
      } else {
        // No UUID generator available; relax NOT NULL if it's set
        if (col.is_nullable === 'NO') {
          await q(`ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL`);
        }
      }
    }

    // Ensure analytics_events exists and has expected columns
    await q(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        folder_id INT,
        name TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        show_donation_detail BOOLEAN DEFAULT TRUE,
        show_expense_detail BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);

    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS folder_id INT`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS name TEXT`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0`);
    await q(`ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

    // Ensure analytics_events.folder_id is integer (drop any FKs on it first)
    const evCol = await getColumn('analytics_events', 'folder_id');
    if (evCol && evCol.data_type !== 'integer') {
      await dropFksOnColumn('analytics_events', 'folder_id');
      await q(`ALTER TABLE analytics_events ALTER COLUMN folder_id TYPE integer USING NULL::integer`);
    }

    // Add FK (ignore if it already exists)
    try {
      await q(`ALTER TABLE analytics_events
               ADD CONSTRAINT fk_analytics_events_folder
               FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID`);
    } catch (_) { /* ignore duplicate */ }

    // Indexes
    await q(`CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))`);
    await q(`CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)`);

    await q('COMMIT');
    console.log('✅ Analytics schema fix applied successfully.');
  } catch (e) {
    try { await q('ROLLBACK'); } catch(_) {}
    console.error('❌ Failed to apply analytics schema fix:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
