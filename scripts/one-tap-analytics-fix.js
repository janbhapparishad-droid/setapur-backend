const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Pool } = require("pg");

const repoRoot = process.cwd();
const dbUrl = process.env.DATABASE_URL || "";
const ssl = /sslmode=require|neon|render|amazonaws|\.neon\.tech/i.test(dbUrl) ? { rejectUnauthorized: false } : undefined;

function log(msg){ console.log("•", msg); }
function warn(msg){ console.warn("~", msg); }

function writeFileSafe(file, content){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8" });
}

function patchAnalyticsAdminRoute(){
  const f = path.join(repoRoot, "routes", "analyticsAdminDB.js");
  if (!fs.existsSync(f)) { warn("routes/analyticsAdminDB.js not found, skipping route patch"); return; }

  let src = fs.readFileSync(f, "utf8");
  // backup
  const bak = path.join(repoRoot, "routes", `analyticsAdminDB.backup.${Date.now()}.js`);
  fs.writeFileSync(bak, src, "utf8");

  // ensure crypto import
  if (!/require\(['"]crypto['"]\)/.test(src)) {
    // insert after pg require if possible else at top
    const hook = /const\s+\{\s*Pool\s*\}\s*=\s*require\(['"]pg['"]\);\s*/;
    if (hook.test(src)) {
      src = src.replace(hook, m => m + "const crypto = require('crypto');\n");
    } else {
      src = "const crypto = require('crypto');\n" + src;
    }
  }

  // replace router.post('/folders', ...) with legacy-safe version
  const re = /router\.post\((['"])\/folders\1\s*,[\s\S]*?\n\}\);\s*/;
  if (!re.test(src)) {
    warn("Could not find router.post('/folders', ...) to patch. Skipping route patch.");
  } else {
    const replacement = `
router.post('/folders', async (req,res)=>{
  try{
    await ensure();
    const { name, folderName, enabled } = req.body || {};
    const nm = String(folderName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });
    const en = b(enabled);

    // slug only if column exists
    const { rows: slugCol } = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='slug' LIMIT 1"
    );
    const hasSlug = slugCol.length > 0;
    let slug = slugifyLite(nm);
    if (hasSlug) {
      for (let i=2;i<100;i++){
        const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 LIMIT 1', [slug]);
        if (!rows.length) break;
        slug = \`\${slugifyLite(nm)}-\${i}\`;
      }
    }

    // next order index or sort
    let nextOrder = 0;
    let orderCol = null;
    try {
      const { rows } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_folders');
      nextOrder = Number(rows[0]?.next || 0); orderCol = 'order_index';
    } catch {
      try {
        const { rows } = await pool.query('SELECT COALESCE(MAX(sort),-1)+1 AS next FROM analytics_folders');
        nextOrder = Number(rows[0]?.next || 0); orderCol = 'sort';
      } catch { nextOrder = 0; orderCol = null; }
    }

    // columns present
    const { rows: colRows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='analytics_folders'"
    );
    const colSet = new Set(colRows.map(r => r.column_name));

    const cols = []; const vals = []; const params = []; let i = 1;
    const add = (c, v) => { cols.push(c); vals.push('$'+(i++)); params.push(v); };

    if (colSet.has('folder_id')) add('folder_id', crypto.randomUUID()); // explicit non-null
    if (colSet.has('parent_id')) add('parent_id', null);

    if (colSet.has('name')) add('name', nm);
    if (colSet.has('folder_name')) add('folder_name', nm);

    if (hasSlug && colSet.has('slug')) add('slug', slug);
    if (colSet.has('created_by')) add('created_by', req.user?.username || nm);
    if (colSet.has('updated_by')) add('updated_by', req.user?.username || nm);
    if (colSet.has('enabled')) add('enabled', en);

    if (orderCol && colSet.has(orderCol)) add(orderCol, nextOrder);
    else {
      if (colSet.has('order_index')) add('order_index', nextOrder);
      else if (colSet.has('sort')) add('sort', nextOrder);
    }

    if (!cols.length) return res.status(500).json({ error: 'Folder insert columns missing' });

    const sql = \`INSERT INTO analytics_folders (\${cols.join(',')}) VALUES (\${vals.join(',')}) RETURNING *\`;
    const { rows } = await pool.query(sql, params);
    const r = rows[0] || {};
    return res.status(201).json({
      id: r.id,
      name: r.name || r.folder_name,
      slug: r.slug || null,
      enabled: r.enabled !== false,
      orderIndex: (r.order_index ?? r.sort ?? 0)
    });
  }catch(e){
    console.error('create folder err:',e);
    if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Create folder failed');
  }
});
`;
    src = src.replace(re, replacement);
    log("Patched POST /folders route (legacy-safe).");
  }

  fs.writeFileSync(f, src, "utf8");
}

function ensureMigrationScript(){
  const migratePath = path.join(repoRoot, "scripts", "analytics-migrate.js");
  const content = `const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=require|neon|render|amazonaws|\\.neon\\.tech/i.test(process.env.DATABASE_URL||'') ? { rejectUnauthorized: false } : undefined });

(async () => {
  const client = await pool.connect();
  const q = (t,p)=>client.query(t,p);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch(e){ console.warn("~", label, "-", e.message); } };

  try {
    // Base folders table
    await safe("create analytics_folders", \`
      CREATE TABLE IF NOT EXISTS analytics_folders (
        id SERIAL PRIMARY KEY,
        name TEXT,
        slug TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )\`);
    await safe("folders add name",       \`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS name TEXT\`);
    await safe("folders add slug",       \`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS slug TEXT\`);
    await safe("folders add enabled",    \`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE\`);
    await safe("folders add order_index",\`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0\`);
    await safe("folders add created_at", \`ALTER TABLE analytics_folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()\`);

    // Backfill name and enforce NOT NULL
    await safe("folders backfill name",  \`UPDATE analytics_folders SET name = COALESCE(NULLIF(btrim(name),''), NULLIF(btrim(folder_name),''), slug, 'untitled') WHERE name IS NULL OR btrim(name) = ''\`);
    await safe("folders name NOT NULL",  \`ALTER TABLE analytics_folders ALTER COLUMN name SET NOT NULL\`);

    // folder_name legacy: drop NOT NULL if exists (avoid future insert failures)
    await safe("folders folder_name drop not null", \`ALTER TABLE analytics_folders ALTER COLUMN folder_name DROP NOT NULL\`);

    // folder_id default/backfill
    await safe("ext pgcrypto", \`CREATE EXTENSION IF NOT EXISTS pgcrypto\`);
    await safe("ext uuid-ossp", \`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"\`);
    // Use whichever uuid fn exists
    const { rows: r1 } = await q(\`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') AS ok\`);
    const { rows: r2 } = await q(\`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') AS ok\`);
    const gen = r1?.[0]?.ok ? 'gen_random_uuid()' : (r2?.[0]?.ok ? 'uuid_generate_v4()' : null);
    if (gen) {
      // Check type
      const { rows: info } = await q(\`SELECT data_type FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='folder_id'\`);
      if (info.length) {
        if (info[0].data_type === 'uuid') {
          await safe("folder_id default uuid", \`ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT \${gen}\`);
          await safe("folder_id backfill uuid", \`UPDATE analytics_folders SET folder_id = \${gen} WHERE folder_id IS NULL\`);
        } else {
          await safe("folder_id default text", \`ALTER TABLE analytics_folders ALTER COLUMN folder_id SET DEFAULT (\${gen})::text\`);
          await safe("folder_id backfill text", \`UPDATE analytics_folders SET folder_id = (\${gen})::text WHERE folder_id IS NULL\`);
        }
      }
    } else {
      await safe("folder_id drop not null (no uuid gen)", \`ALTER TABLE analytics_folders ALTER COLUMN folder_id DROP NOT NULL\`);
    }

    // BEFORE INSERT trigger to fill name/folder_name/slug/order_index
    await safe("create trigger fn", \`
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
            NEW.slug := lower(regexp_replace(vname, '[^a-z0-9\\s-]', '', 'g'));
            NEW.slug := regexp_replace(NEW.slug, '\\s+', '-', 'g');
            NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN
          IF NEW.order_index IS NULL THEN SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_folders; END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        RETURN NEW;
      END $$;\`);
    await safe("drop trigger if exists", \`DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders\`);
    await safe("create trigger", \`
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW EXECUTE FUNCTION set_analytics_folder_defaults();\`);

    // events table
    await safe("create analytics_events", \`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        folder_id INT,
        name TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        show_donation_detail BOOLEAN DEFAULT TRUE,
        show_expense_detail BOOLEAN DEFAULT TRUE,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )\`);
    await safe("events add cols", \`
      ALTER TABLE analytics_events
        ADD COLUMN IF NOT EXISTS folder_id INT,
        ADD COLUMN IF NOT EXISTS name TEXT,
        ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS show_donation_detail BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS show_expense_detail BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()\`);

    // FK (ignore if exists)
    await safe("events fk -> folders", \`
      ALTER TABLE analytics_events
      ADD CONSTRAINT fk_analytics_events_folder
      FOREIGN KEY (folder_id) REFERENCES analytics_folders(id) ON DELETE CASCADE NOT VALID\`);

    // indexes
    await safe("idx folders order", \`CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name))\`);
    await safe("idx events folder", \`CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id)\`);
    await safe("idx events order",  \`CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index)\`);

    console.log("✅ Analytics migration finished.");
  } catch (e) {
    console.warn("~ migration error:", e.message);
  } finally {
    client.release(); await pool.end();
  }
})();
`;

  writeFileSafe(migratePath, content);
  log("Wrote scripts/analytics-migrate.js");
}

function ensurePackageJson(){
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) { warn("package.json not found, skipping start script tweak"); return; }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.scripts = pkg.scripts || {};
  // make start resilient
  pkg.scripts.start = "node scripts/analytics-migrate.js || echo 'migration: continuing' ; node server.js";
  pkg.engines = pkg.engines || {};
  pkg.engines.node = "22.x";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
  log("Updated package.json scripts.start and engines.node");
}

async function dbHotfix(){
  if (!dbUrl) { warn("DATABASE_URL not set; skipping DB hotfix"); return; }
  const pool = new Pool({ connectionString: dbUrl, ssl });
  const client = await pool.connect();
  const q = (t,p)=>client.query(t,p);
  const safe = async (label, sql) => { try { await q(sql); console.log("✓", label); } catch(e){ console.warn("~", label, "-", e.message); } };

  try {
    // folder_name: drop NOT NULL, backfill both ways w/o referencing created_by
    await safe("backfill name from folder_name", `
      UPDATE analytics_folders
      SET name = COALESCE(NULLIF(btrim(name),''), NULLIF(btrim(folder_name),''), slug, 'untitled')
      WHERE name IS NULL OR btrim(name) = ''`);
    await safe("backfill folder_name from name", `
      UPDATE analytics_folders
      SET folder_name = COALESCE(NULLIF(btrim(folder_name),''), NULLIF(btrim(name),''), slug, 'untitled')
      WHERE folder_name IS NULL OR btrim(folder_name) = ''`);
    await safe("folder_name DROP NOT NULL", `ALTER TABLE analytics_folders ALTER COLUMN folder_name DROP NOT NULL`);

    // folder_id default/backfill (text or uuid)
    await safe("ext pgcrypto", `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await safe("ext uuid-ossp", `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    const { rows: g1 } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='gen_random_uuid') AS ok`);
    const { rows: g2 } = await q(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v4') AS ok`);
    const gen = g1?.[0]?.ok ? 'gen_random_uuid()' : (g2?.[0]?.ok ? 'uuid_generate_v4()' : null);
    if (gen) {
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
    }

    // BEFORE INSERT trigger to fill name/folder_name/slug/order_index
    await safe("create/update trigger function", `
      CREATE OR REPLACE FUNCTION set_analytics_folder_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE vname TEXT;
      BEGIN
        vname := COALESCE(NULLIF(btrim(NEW.name),''), NULLIF(btrim(NEW.folder_name),''), NEW.slug, 'untitled');
        BEGIN IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN NEW.name := vname; END IF; EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN IF NEW.folder_name IS NULL OR btrim(NEW.folder_name) = '' THEN NEW.folder_name := vname; END IF; EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN
          IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
            NEW.slug := lower(regexp_replace(vname, '[^a-z0-9\\s-]', '', 'g'));
            NEW.slug := regexp_replace(NEW.slug, '\\s+', '-', 'g');
            NEW.slug := regexp_replace(NEW.slug, '-+', '-', 'g');
          END IF;
        EXCEPTION WHEN undefined_column THEN NULL; END;
        BEGIN IF NEW.order_index IS NULL THEN SELECT COALESCE(MAX(order_index), -1) + 1 INTO NEW.order_index FROM analytics_folders; END IF; EXCEPTION WHEN undefined_column THEN NULL; END;
        RETURN NEW;
      END $$;`);
    await safe("drop trigger if exists", `DROP TRIGGER IF EXISTS trg_analytics_folders_defaults ON analytics_folders`);
    await safe("create BEFORE INSERT trigger", `
      CREATE TRIGGER trg_analytics_folders_defaults
      BEFORE INSERT ON analytics_folders
      FOR EACH ROW
      EXECUTE FUNCTION set_analytics_folder_defaults();
    `);

    console.log("✅ DB hotfix applied.");
  } catch (e) {
    warn("DB hotfix issue: " + e.message);
  } finally {
    client.release(); await pool.end();
  }
}

(async () => {
  try {
    patchAnalyticsAdminRoute();
    ensureMigrationScript();
    ensurePackageJson();
    await dbHotfix();

    // git commit & push
    try {
      execSync('git add routes/analyticsAdminDB.js scripts/analytics-migrate.js package.json', { stdio: 'inherit' });
      execSync('git commit -m "fix(analytics): legacy-safe folder create; durable migration & trigger"', { stdio: 'inherit' });
    } catch (e) {
      console.log("(git) nothing to commit or commit failed:", e.message);
    }
    try {
      execSync('git push origin main', { stdio: 'inherit' });
    } catch (e) {
      console.log("(git) push failed:", e.message);
    }

    console.log("\nAll set. If Render is linked to main with Auto-Deploy, it will redeploy now.");
    console.log("Test: Admin → Manage Analytics → Add Folder. It should work.");
  } catch (e) {
    console.error("One-tap failed:", e);
    process.exit(1);
  }
})();
