const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const c = await pool.connect();
  const q = (s,p)=>c.query(s,p);
  async function existsCol(tbl, col){
    const { rows } = await q(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl,col]);
    return rows.length>0;
  }
  async function colInfo(tbl, col){
    const { rows } = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl,col]);
    return rows[0] || null;
  }
  const safe = async (label, sql) => {
    try { await q(sql); console.log("✓", label); }
    catch (e) { console.warn("~", label, "-", e.message); }
  };

  try {
    // 1) parent_id: drop NOT NULL (do NOT set default 0, because it may be UUID)
    if (await existsCol('analytics_folders','parent_id')) {
      const info = await colInfo('analytics_folders','parent_id');
      if (info && info.is_nullable === 'NO') {
        await safe("parent_id DROP NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN parent_id DROP NOT NULL`);
      } else {
        console.log("✓ parent_id already nullable or not constrained");
      }
      // Make sure default is NULL (no default)
      await safe("parent_id DROP DEFAULT", `ALTER TABLE analytics_folders ALTER COLUMN parent_id DROP DEFAULT`);
    } else {
      console.log("~ parent_id column not present (skip)");
    }

    // 2) folder_id: ensure default + backfill, so inserts never miss it
    if (await existsCol('analytics_folders','folder_id')) {
      // Try to enable UUID functions (best effort)
      await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await safe('ext uuid-ossp', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

      // Detect generator
      let genFn = 'gen_random_uuid()';
      try {
        const { rows } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') AS ok`);
        if (!rows[0]?.ok) {
          const u = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') AS ok`);
          genFn = u.rows[0]?.ok ? 'uuid_generate_v4()' : null;
        }
      } catch {}
      const fi = await colInfo('analytics_folders','folder_id');
      if (genFn && fi) {
        if (fi.data_type === 'uuid') {
          await safe("folder_id default uuid", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT ${genFn}`);
          await safe("folder_id backfill uuid", `UPDATE analytics_folders SET folder_id = ${genFn} WHERE folder_id IS NULL`);
        } else {
          await safe("folder_id default text", `ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (${genFn})::text`);
          await safe("folder_id backfill text", `UPDATE analytics_folders SET folder_id = (${genFn})::text WHERE folder_id IS NULL`);
        }
      } else {
        // if no uuid gen available, at least relax NOT NULL so inserts don't fail
        if (fi && fi.is_nullable === 'NO') {
          await safe("folder_id DROP NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL`);
        }
      }
    } else {
      console.log("~ folder_id column not present (skip)");
    }

    // 3) Optional: create BEFORE INSERT trigger to auto-fill name/slug if missing
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
      $$;
    `);
    await safe("drop trigger if exists", `DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders`);
    await safe("create trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_folder_defaults();
    `);

    // 4) Print current column status for sanity
    const { rows: cols } = await q(`
      SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name='analytics_folders'
        AND column_name IN ('folder_id','parent_id','name','slug','order_index','sort')
      ORDER BY column_name`);
    console.table(cols);

    console.log("✅ Hotfix applied. Try creating the folder again.");
  } catch (e) {
    console.error("❌ Hotfix failed:", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
