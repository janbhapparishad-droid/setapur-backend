const { Pool } = require("pg");
const cs = process.env.DATABASE_URL || "";
const useSSL =
  /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(cs) ||
  /^(1|true|require)$/i.test(process.env.PGSSL || process.env.PGSSLMODE || "");

const pool = new Pool({ connectionString: cs, ssl: useSSL ? { rejectUnauthorized:false } : undefined });

(async () => {
  const c = await pool.connect();
  const q = (s,p)=>c.query(s,p);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch(e){ console.warn("~", label, "-", e.message); } };
  async function colInfo(tbl, col){
    const { rows } = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl,col]);
    return rows[0] || null;
  }
  try {
    // Extensions for uuid gen (best effort)
    await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await safe('ext uuid-ossp', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Pick generator
    let gen = 'gen_random_uuid()';
    try {
      const a = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') AS ok`);
      if (!a.rows[0]?.ok) {
        const b = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') AS ok`);
        gen = b.rows[0]?.ok ? 'uuid_generate_v4()' : null;
      }
    } catch {}

    const info = await colInfo('analytics_events','event_id');
    if (info) {
      if (gen) {
        if (info.data_type === 'uuid') {
          await safe("event_id default uuid", `ALTER TABLE analytics_events ALTER COLUMN event_id SET DEFAULT ${gen}`);
          await safe("event_id backfill uuid", `UPDATE analytics_events SET event_id = ${gen} WHERE event_id IS NULL`);
        } else {
          await safe("event_id default text", `ALTER TABLE analytics_events ALTER COLUMN event_id SET DEFAULT (${gen})::text`);
          await safe("event_id backfill text", `UPDATE analytics_events SET event_id = (${gen})::text WHERE event_id IS NULL`);
        }
      } else {
        // No generator available; at least relax NOT NULL to unblock inserts
        if (info.is_nullable === 'NO') {
          await safe("event_id DROP NOT NULL", `ALTER TABLE analytics_events ALTER COLUMN event_id DROP NOT NULL`);
        }
      }
    } else {
      console.log("~ events: event_id column not present (nothing to do)");
    }
    console.log("✅ event_id hotfix applied.");
  } catch (e) {
    console.error("❌ event_id hotfix failed:", e.message);
    process.exitCode = 1;
  } finally {
    c.release(); await pool.end();
  }
})();
