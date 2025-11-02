const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(process.env.DATABASE_URL||'') ? { rejectUnauthorized: false } : undefined });

(async () => {
  const client = await pool.connect();
  const q = (t,p)=>client.query(t,p);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch(e){ console.warn("~", label, "-", e.message); } };

  try {
    // Base folders table
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

    // Backfill name and enforce NOT NULL
    await safe("folders backfill name",  `UPDATE analytics_folders SET name = COALESCE(NULLIF(btrim(name),''), NULLIF(btrim(folder_name),''), slug, 'untitled') WHERE name IS NULL OR btrim(name) = ''`);
    await safe("folders name NOT NULL",  `ALTER TABLE analytics_folders ALTER COLUMN name SET NOT NULL`);

    // folder_name legacy: drop NOT NULL if exists (avoid future insert failures)
    await safe("folders folder_name drop not null", `ALTER TABLE analytics_folders ALTER COLUMN folder_name DROP NOT NULL`);

    // folder_id default/backfill
    await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await safe("ext uuid-ossp", `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    // Use whichever uuid fn exists
    const { rows: r1 } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') AS ok`);
    const { rows: r2 } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') AS ok`);
    const gen = r1?.[0]?.ok ? 'gen_random_uuid()' : (r2?.[0]?.ok ? 'uuid_generate_v4()' : null);
    if (gen) {
      // Check type
      const { rows: info } = await q(`SELECT data_type FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='folder_id'`);
      if (info.length) {
        if (info[0].data_type === 'uuid') {
          await safe("folder_id default uuid", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ${gen}`);
          await safe("folder_id backfill uuid", `UPDATE analytics_folders SET folder_id = ${gen} WHERE folder_id IS NULL`);
        } else {
          await safe("folder_id default text", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (${gen})::text`);
          await safe("folder_id backfill text", `UPDATE analytics_folders SET folder_id = (${gen})::text WHERE folder_id IS NULL`);
        }
      }
    } else {
      await safe("folder_id drop not null (no uuid gen)", `ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL`);
    }

    // BEFORE INSERT trigger to fill name/folder_name/slug/order_index
    await safe("create trigger fn", `
      CREATE OR REPLACE FUNCTION set_analytics_folder_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE vname TEXT;
      BEGIN
        vname := COALESCE(NULLIF(btrim(NEW.name),''), NULLIF(btrim(NEW.folder_name),''), NEW.slug, 'untitled');
        BEGIN
          IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN NEW.name := vname; END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN
          IF NEW.folder_name IS NULL OR btrim(NEW.folder_name) = '' THEN NEW.folder_name := vname; END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN
          IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
            NEW.slug := lower(regexp_replace(vname, '[^a-z0-9\s-]', '', 'g'));
            NEW.slug := regexp_replace(NEW.slug, '\s+', '-', 'g');
            NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN
          IF NEW.order_index IS NULL THEN SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_folders; END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        RETURN NEW;
      END $$;`);
    await safe("drop trigger if exists", `DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders`);
    await safe("create trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW EXECUTE FUNCTION set_analytics_folder_defaults();`);

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
    await safe("events add cols", `
      ALTER TABLE analytics_events
        ADD COLUMN IF NOT EXISTS folder_id INT,
        ADD COLUMN IF NOT EXISTS name TEXT,
        ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

    // FK (ignore if exists)
    await safe("events fk -> folders", `
      ALTER TABLE analytics_events
      ADD CONSTRAINT fk_analytics_events_folder
      FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID`);

    // indexes
    await safe("idx folders order", `CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))`);
    await safe("idx events folder", `CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)`);
    await safe("idx events order",  `CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)`);

    console.log("✅ Analytics migration finished.");
  } catch (e) {
    console.warn("~ migration error:", e.message);
  } finally {
    client.release(); await pool.end();
  }
})();
