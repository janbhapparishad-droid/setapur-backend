const { Pool } = require("pg");
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false }
  });
  try {
    console.log("== Constraints on analytics_folders ==");
    const cons = await pool.query(
      "SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='analytics_folders'::regclass"
    );
    console.table(cons.rows);

    console.log("== Indexes on analytics_folders ==");
    const idx = await pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='analytics_folders'"
    );
    console.table(idx.rows);

    console.log("== Current rows ==");
    const rows = await pool.query("SELECT id, name, slug FROM analytics_folders ORDER BY id");
    console.table(rows.rows);

    console.log("== Test insert (to see real PG error details) ==");
    const nm = "AdminTest " + new Date().toISOString();
    const sl = "admintest-" + Date.now();
    try {
      const ins = await pool.query(
        "INSERT INTO analytics_folders(name, slug, enabled, order_index) VALUES ($1,$2,true, COALESCE((SELECT COALESCE(MAX(order_index),-1)+1 FROM analytics_folders),0)) RETURNING id,name,slug",
        [nm, sl]
      );
      console.log("Inserted:", ins.rows[0]);
    } catch (e) {
      console.log("INSERT error code:", e.code);
      console.log("INSERT constraint:", e.constraint);
      console.log("INSERT detail:", e.detail);
      console.log("INSERT message:", e.message);
    }
  } catch (e) {
    console.error("Diag failed:", e);
  } finally {
    process.exit(0);
  }
})();
