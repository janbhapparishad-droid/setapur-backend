const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
    // 1) Backfill name <-> event_name (if event_name exists)
    if (await existsCol('analytics_events','event_name')) {
      await safe("events: backfill name from event_name",
        `UPDATE analytics_events
         SET name = COALESCE(NULLIF(btrim(name),''), NULLIF(btrim(event_name),''), 'event')
         WHERE name IS NULL OR btrim(name) = ''`);
      await safe("events: backfill event_name from name",
        `UPDATE analytics_events
         SET event_name = COALESCE(NULLIF(btrim(event_name),''), NULLIF(btrim(name),''), 'event')
         WHERE event_name IS NULL OR btrim(event_name) = ''`);

      const info = await colInfo('analytics_events','event_name');
      if (info && info.is_nullable === 'NO') {
        await safe("events: event_name DROP NOT NULL", `ALTER TABLE analytics_events ALTER COLUMN event_name DROP NOT NULL`);
      }
    } else {
      console.log("~ events: column event_name not present (ok)");
    }

    // 2) Relax legacy NOT NULL on created_by/updated_by if present
    for (const col of ['created_by','updated_by']) {
      if (await existsCol('analytics_events', col)) {
        const info = await colInfo('analytics_events', col);
        if (info && info.is_nullable === 'NO') {
          await safe(`events: ${col} DROP NOT NULL`, `ALTER TABLE analytics_events ALTER COLUMN ${col} DROP NOT NULL`);
        }
      }
    }

    // 3) Ensure booleans default to true and backfill NULLs
    await safe("events: enabled default true", `ALTER TABLE analytics_events ALTER COLUMN enabled SET DEFAULT TRUE`);
    await safe("events: enabled backfill true", `UPDATE analytics_events SET enabled = TRUE WHERE enabled IS NULL`);
    await safe("events: show_donation_detail default true", `ALTER TABLE analytics_events ALTER COLUMN show_donation_detail SET DEFAULT TRUE`);
    await safe("events: show_donation_detail backfill", `UPDATE analytics_events SET show_donation_detail = TRUE WHERE show_donation_detail IS NULL`);
    await safe("events: show_expense_detail default true", `ALTER TABLE analytics_events ALTER COLUMN show_expense_detail SET DEFAULT TRUE`);
    await safe("events: show_expense_detail backfill", `UPDATE analytics_events SET show_expense_detail = TRUE WHERE show_expense_detail IS NULL`);

    // 4) order_index default and backfill
    await safe("events: order_index default 0", `ALTER TABLE analytics_events ALTER COLUMN order_index SET DEFAULT 0`);
    await safe("events: order_index backfill 0", `UPDATE analytics_events SET order_index = 0 WHERE order_index IS NULL`);

    // 5) Optional: legacy "sort" → copy into order_index if present and order_index=0
    if (await existsCol('analytics_events','sort')) {
      await safe("events: copy sort->order_index",
        `UPDATE analytics_events SET order_index = sort WHERE (order_index IS NULL OR order_index = 0) AND sort IS NOT NULL`);
    }

    // 6) BEFORE INSERT trigger to auto-fill name/event_name/booleans/order
    await safe("events: create/update trigger fn", `
      CREATE OR REPLACE FUNCTION set_analytics_event_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE vname TEXT;
      BEGIN
        -- compute a name
        BEGIN
          vname := COALESCE(NULLIF(btrim(NEW.name),''), NULLIF(btrim(NEW.event_name),''), 'event');
        EXCEPTION WHEN undefined_column THEN
          vname := COALESCE(NULLIF(btrim(NEW.name),''), 'event');
        END;

        -- set name if blank
        IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
          NEW.name := vname;
        END IF;

        -- set event_name if column present and blank
        BEGIN
          IF NEW.event_name IS NULL OR btrim(NEW.event_name) = '' THEN
            NEW.event_name := vname;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        -- booleans default true
        IF NEW.enabled IS NULL THEN NEW.enabled := TRUE; END IF;
        IF NEW.show_donation_detail IS NULL THEN NEW.show_donation_detail := TRUE; END IF;
        IF NEW.show_expense_detail IS NULL THEN NEW.show_expense_detail := TRUE; END IF;

        -- order assignment
        IF NEW.order_index IS NULL OR NEW.order_index = 0 THEN
          SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_events WHERE folder_id = NEW.folder_id;
        END IF;

        -- legacy sort if exists
        BEGIN
          IF NEW.sort IS NULL THEN
            SELECT COALESCE(MAX(sort), -1) + 1 INTO NEW.sort FROM analytics_events WHERE folder_id = NEW.folder_id;
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;

        RETURN NEW;
      END
      $$;
    `);
    await safe("events: drop old trigger if any", `DROP TRIGGER IF EXISTS trg_analytics_events_defaults ON analytics_events`);
    await safe("events: create BEFORE INSERT trigger", `
      CREATE TRIGGER trg_analytics_events_defaults
      BEFORE INSERT ON analytics_events
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_event_defaults();
    `);

    // 7) Show columns to confirm
    const { rows } = await q(`
      SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name='analytics_events'
      ORDER BY column_name
    `);
    console.table(rows);

    console.log("✅ Events hotfix applied. Try creating the event again.");
  } catch (e) {
    console.error("❌ Events hotfix failed:", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
