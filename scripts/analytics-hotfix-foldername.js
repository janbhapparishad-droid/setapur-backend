const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  const q = (s,p)=>c.query(s,p);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch(e){ console.warn("~", label, "-", e.message); } };
  async function existsCol(tbl, col){
    const { rows } = await q(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl,col]);
    return rows.length>0;
  }
  async function colInfo(tbl, col){
    const { rows } = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl,col]);
    return rows[0] || null;
  }

  try {
    const hasFolderName = await existsCol('analytics_folders','folder_name');
    const hasName       = await existsCol('analytics_folders','name');

    if (hasFolderName && hasName) {
      await safe("backfill name from folder_name",
        `UPDATE analytics_folders
         SET name = COALESCE(NULLIF(btrim(name),''), folder_name, created_by, slug, 'untitled')
         WHERE name IS NULL OR btrim(name) = ''`);

      await safe("backfill folder_name from name",
        `UPDATE analytics_folders
         SET folder_name = COALESCE(NULLIF(btrim(folder_name),''), name, created_by, slug, 'untitled')
         WHERE folder_name IS NULL OR btrim(folder_name) = ''`);

      const info = await colInfo('analytics_folders','folder_name');
      if (info && info.is_nullable === 'NO') {
        await safe("folder_name DROP NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN folder_name DROP NOT NULL`);
      } else {
        console.log("✓ folder_name already nullable");
      }
    } else if (hasFolderName && !hasName) {
      await safe("rename folder_name -> name", `ALTER TABLE analytics_folders RENAME COLUMN folder_name TO name`);
    } else {
      console.log("~ folder_name column not present (skip)");
    }

    // Trigger: name + folder_name auto-fill before insert
    await safe("create/update trigger function", `
      CREATE OR REPLACE FUNCTION set_analytics_folder_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        vname TEXT;
      BEGIN
        BEGIN
          vname := COALESCE(NULLIF(btrim(NEW.name),''), NULLIF(btrim(NEW.folder_name),''), NEW.created_by, NEW.slug, 'untitled');
        EXCEPTION WHEN undefined_column THEN
          vname := COALESCE(NULLIF(btrim(NEW.name),''), NEW.created_by, NEW.slug, 'untitled');
        END;

        BEGIN
          IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
            NEW.name := vname;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        BEGIN
          IF NEW.folder_name IS NULL OR btrim(NEW.folder_name) = '' THEN
            NEW.folder_name := vname;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        BEGIN
          IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
            NEW.slug := lower(regexp_replace(vname, '[^a-z0-9\\s-]', '', 'g'));
            NEW.slug := regexp_replace(NEW.slug, '\\s+', '-', 'g');
            NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

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
    await safe("create BEFORE INSERT trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_folder_defaults();
    `);

    // Show current columns
    const { rows } = await q(`
      SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name='analytics_folders'
        AND column_name IN ('folder_id','folder_name','name','slug','order_index','sort','created_by','updated_by')
      ORDER BY column_name
    `);
    console.table(rows);

    console.log("✅ Hotfix done. Try 'Add Folder' again in the app.");
  } catch (e) {
    console.error("❌ Hotfix failed:", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
