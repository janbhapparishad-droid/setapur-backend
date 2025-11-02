const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Error: DATABASE_URL not set. Please set $env:DATABASE_URL to your Render/Neon Postgres URL.");
  process.exit(1);
}

const useSSL = /sslmode=require|render|neon|amazonaws|\.neon\.tech/i.test(connectionString)
            || /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || "");
const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

const sql = `
BEGIN;

-- Ensure analytics_folders table exists
CREATE TABLE IF NOT EXISTS analytics_folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  order_index INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Try to enable UUID generators (ignore errors if not allowed)
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Ensure required columns on analytics_folders (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='name') THEN
    EXECUTE 'ALTER TABLE analytics_folders ADD COLUMN name TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='slug') THEN
    EXECUTE 'ALTER TABLE analytics_folders ADD COLUMN slug TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='enabled') THEN
    EXECUTE 'ALTER TABLE analytics_folders ADD COLUMN enabled BOOLEAN DEFAULT TRUE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='order_index') THEN
    EXECUTE 'ALTER TABLE analytics_folders ADD COLUMN order_index INT DEFAULT 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='created_at') THEN
    EXECUTE 'ALTER TABLE analytics_folders ADD COLUMN created_at TIMESTAMPTZ DEFAULT now()';
  END IF;
END $$;

-- Backfill name if missing
UPDATE analytics_folders
SET name = COALESCE(name, slug, 'Group-'||id::text)
WHERE name IS NULL;

-- Enforce NOT NULL on name
ALTER TABLE analytics_folders
  ALTER COLUMN name SET NOT NULL;

-- If legacy "sort" column exists, copy it into order_index where order_index is null/zero
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='analytics_folders' AND column_name='sort'
  ) THEN
    UPDATE analytics_folders f
    SET order_index = s.sort
    FROM (SELECT id, sort FROM analytics_folders) s
    WHERE f.id = s.id
      AND (f.order_index IS NULL OR f.order_index = 0)
      AND s.sort IS NOT NULL;
  END IF;
END $$;

-- Handle legacy folder_id: set default + backfill; or relax NOT NULL if no uuid fn available
DO $$
DECLARE
  coltype TEXT;
  isnull TEXT;
  fn TEXT;
BEGIN
  -- detect available UUID generator
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') THEN
    fn := 'gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') THEN
    fn := 'uuid_generate_v4()';
  ELSE
    fn := NULL;
  END IF;

  SELECT data_type, is_nullable INTO coltype, isnull
  FROM information_schema.columns
  WHERE table_name='analytics_folders' AND column_name='folder_id';

  IF coltype IS NOT NULL THEN
    IF fn IS NOT NULL THEN
      IF coltype = 'uuid' THEN
        EXECUTE 'ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT '||fn;
        EXECUTE 'UPDATE analytics_folders SET folder_id = '||fn||' WHERE folder_id IS NULL';
      ELSE
        EXECUTE 'ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ('||fn||')::text';
        EXECUTE 'UPDATE analytics_folders SET folder_id = ('||fn||')::text WHERE folder_id IS NULL';
      END IF;
    ELSE
      -- No uuid generator available; ensure NOT NULL won't block inserts
      IF isnull = 'NO' THEN
        EXECUTE 'ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL';
      END IF;
    END IF;
  END IF;
END $$;

-- Ensure analytics_events exists
CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  folder_id INT,
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  show_donation_detail BOOLEAN DEFAULT TRUE,
  show_expense_detail BOOLEAN DEFAULT TRUE,
  order_index INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure expected columns on analytics_events
ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS folder_id INT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Make sure folder_id column type is integer
DO $$
DECLARE
  ct TEXT;
  cname TEXT;
BEGIN
  SELECT data_type INTO ct
  FROM information_schema.columns
  WHERE table_name='analytics_events' AND column_name='folder_id';

  IF ct IS NOT NULL AND ct <> 'integer' THEN
    -- drop FK if exists on folder_id
    SELECT tc.constraint_name INTO cname
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
    WHERE tc.table_name='analytics_events' AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name='folder_id'
    LIMIT 1;

    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE analytics_events DROP CONSTRAINT %I', cname);
    END IF;

    -- convert type to integer (reset values to NULL)
    EXECUTE 'ALTER TABLE analytics_events ALTER COLUMN folder_id TYPE integer USING NULL::integer';
  END IF;
END $$;

-- Add FK (not validated immediately to avoid legacy rows blocking)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name='analytics_events'
      AND constraint_type='FOREIGN KEY'
      AND constraint_name='fk_analytics_events_folder'
  ) THEN
    BEGIN
      ALTER TABLE analytics_events
        ADD CONSTRAINT fk_analytics_events_folder
        FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name));
CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index);

COMMIT;
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("✅ Analytics schema fix applied successfully.");
  } catch (e) {
    console.error("❌ Failed to apply analytics schema fix:", e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
