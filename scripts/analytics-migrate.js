const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set.");
  process.exit(0);
}

const useSSL = /sslmode=require|render|neon|amazonaws|\.neon\.tech/i.test(connectionString)
            || /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || "");
const pool = new Pool({ connectionString, ssl: useSSL ? { rejectUnauthorized: false } : undefined });

(async () => {
  const client = await pool.connect();
  const q = (text, params) => client.query(text, params);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch (e) { console.warn("~", label, "-", e.message); } };
  async function colExists(table, column) {
    const { rows } = await q(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column]);
    return rows.length > 0;
  }
  async function getColumn(table, column) {
    const { rows } = await q(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column]);
    return rows[0] || null;
  }
  async function funcExists(name) {
    const { rows } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname=$1) AS ok`, [name]);
    return !!rows[0]?.ok;
  }
  function qi(ident){ return '"' + String(ident).replace(/"/g,'""') + '"'; }
  async function dropFksOnColumn(table, column) {
    const { rows } = await q(`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
      WHERE tc.table_name=$1 AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name=$2`, [table, column]);
    for (const r of rows) await safe(`drop FK ${table}.${r.constraint_name}`, `ALTER TABLE ${table} DROP CONSTRAINT ${qi(r.constraint_name)}`);
  }

  try {
    // Folders table and columns
    await safe("create analytics_folders", `
      CREATE TABLE IF NOT EXISTS analytics_folders (
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

    // backfill + enforce name
    await safe("folders backfill name",  `UPDATE analytics_folders SET name = COALESCE(name, slug, 'Group-'||id::text) WHERE name IS NULL`);
    await safe("folders name NOT NULL",  `ALTER TABLE analytics_folders ALTER COLUMN name SET NOT NULL`);

    // legacy: copy sort -> order_index if sort exists
    await safe("folders copy sort->order_index", `UPDATE analytics_folders SET order_index = sort WHERE (order_index IS NULL OR order_index = 0) AND sort IS NOT NULL`);

    // legacy: parent_id can be enforced in older schema; make it nullable if it exists
    await safe("folders parent_id nullable", `ALTER TABLE analytics_folders ALTER COLUMN parent_id DROP NOT NULL`);
    await safe("folders parent_id drop default", `ALTER TABLE analytics_folders ALTER COLUMN parent_id DROP DEFAULT`);

    // legacy: folder_id default/backfill
    if (await colExists('analytics_folders','folder_id')) {
      await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await safe(`ext uuid-ossp`, `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      const hasGen = await funcExists('gen_random_uuid'); const hasV4 = await funcExists('uuid_generate_v4');
      const gen = hasGen ? 'gen_random_uuid()' : (hasV4 ? 'uuid_generate_v4()' : null);
      const col = await getColumn('analytics_folders','folder_id');
      if (gen && col) {
        if (col.data_type === 'uuid') {
          await safe("folder_id default (uuid)", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ${gen}`);
          await safe("folder_id backfill (uuid)", `UPDATE analytics_folders SET folder_id = ${gen} WHERE folder_id IS NULL`);
        } else {
          await safe("folder_id default (text)", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (${gen})::text`);
          await safe("folder_id backfill (text)", `UPDATE analytics_folders SET folder_id = (${gen})::text WHERE folder_id IS NULL`);
        }
      } else if (col && col.is_nullable === 'NO') {
        await safe("folder_id drop NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL`);
      }
    }

    // BEFORE INSERT trigger: auto-fill name/slug/order_index/sort
    await safe("create function set_analytics_folder_defaults", `
      CREATE OR REPLACE FUNCTION set_analytics_folder_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
          BEGIN
            NEW.name := COALESCE(NEW.created_by, NEW.slug, 'untitled');
          EXCEPTION WHEN undefined_column THEN
            NEW.name := COALESCE(NEW.slug, 'untitled');
          END;
        END IF;

        IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
          NEW.slug := lower(regexp_replace(NEW.name, '[^a-z0-9\\s-]', '', 'g'));
          NEW.slug := regexp_replace(NEW.slug, '\\s+', '-', 'g');
          NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
        END IF;

        BEGIN
          IF NEW.order_index IS NULL THEN
            SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_folders;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        BEGIN
          IF NEW.sort IS NULL THEN
            SELECT COALESCE(MAX(sort), -1) + 1 INTO NEW.sort FROM analytics_folders;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        RETURN NEW;
      END
      $$;`);
    await safe("drop trigger if exists", `DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders`);
    await safe("create trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_folder_defaults();
    `);

    // events table
    await safe("create analytics_events", `
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
    await safe("events add folder_id",   `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS folder_id INT`);
    await safe("events add name",        `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS name TEXT`);
    await safe("events add enabled",     `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await safe("events add show_don",    `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE`);
    await safe("events add show_exp",    `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE`);
    await safe("events add order_index", `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0`);
    await safe("events add created_at",  `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

    // ensure integer folder_id + FK
    const evCol = await getColumn('analytics_events','folder_id');
    if (evCol && evCol.data_type !== 'integer') {
      await dropFksOnColumn('analytics_events','folder_id');
      await safe("events folder_id to integer", `ALTER TABLE analytics_events ALTER COLUMN folder_id TYPE integer USING NULL::integer`);
    }
    await safe("events fk -> folders", `
      ALTER TABLE analytics_events
      ADD CONSTRAINT fk_analytics_events_folder
      FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID
    `);

    // indexes
    await safe("idx folders order", `CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))`);
    await safe("idx events folder", `CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)`);
    await safe("idx events order",  `CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)`);

    console.log("✅ Analytics migration finished.");
  } catch (e) {
    console.warn("~ migration error:", e.message);
  } finally {
    client.release();
    await pool.end();
  }
})();
