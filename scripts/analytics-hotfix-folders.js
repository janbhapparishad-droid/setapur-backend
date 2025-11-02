const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const client = await pool.connect();
  const q = (text, params) => client.query(text, params);
  const safe = async (label, sql) => {
    try { await q(sql); console.log("✓", label); }
    catch (e) { console.warn("~", label, "-", e.message); }
  };

  try {
    // Trigger function: fill name from created_by (if present) or fallback; build slug; set order_index/sort.
    await safe("create function set_analytics_folder_defaults", `
      CREATE OR REPLACE FUNCTION set_analytics_folder_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- Fill name if missing
        IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
          BEGIN
            NEW.name := COALESCE(NEW.created_by, NEW.slug, 'untitled');
          EXCEPTION WHEN undefined_column THEN
            NEW.name := COALESCE(NEW.slug, 'untitled');
          END;
        END IF;

        -- Build slug if missing (very light slugify)
        IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
          NEW.slug := lower(regexp_replace(NEW.name, '[^a-z0-9\\s-]', '', 'g'));
          NEW.slug := regexp_replace(NEW.slug, '\\s+', '-', 'g');
          NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
        END IF;

        -- order_index if column exists and value missing
        BEGIN
          IF NEW.order_index IS NULL THEN
            SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_folders;
          END IF;
        EXCEPTION WHEN undefined_column THEN
          -- ignore if column doesn't exist
          NULL;
        END;

        -- sort if legacy column exists and value missing
        BEGIN
          IF NEW.sort IS NULL THEN
            SELECT COALESCE(MAX(sort), -1) + 1 INTO NEW.sort FROM analytics_folders;
          END IF;
        EXCEPTION WHEN undefined_column THEN
          NULL;
        END;

        RETURN NEW;
      END
      $$;
    `);

    await safe("drop trigger if exists", `
      DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders;
    `);

    await safe("create BEFORE INSERT trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_folder_defaults();
    `);

    console.log("✅ Hotfix applied: folders will auto-fill name/slug.");
  } catch (e) {
    console.error("❌ Hotfix failed:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
