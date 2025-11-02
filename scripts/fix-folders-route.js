const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "routes", "analyticsAdminDB.js");
if (!fs.existsSync(file)) {
  console.error("routes/analyticsAdminDB.js not found");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");

// Backup original
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// Ensure crypto import exists
if (!/require\(['"]crypto['"]\)/.test(src)) {
  const hook = /const\s+\{\s*Pool\s*\}\s*=\s*require\(['"]pg['"]\);\s*/;
  if (hook.test(src)) src = src.replace(hook, m => m + "const crypto = require('crypto');\n");
  else src = "const crypto = require('crypto');\n" + src;
}

// Prepare new folders route (no template variables, safe quotes)
const newFoldersRoute = `
router.post('/folders', async (req,res)=>{
  try{
    await ensure();
    const { name, folderName, enabled } = req.body || {};
    const nm = String(folderName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });
    const en = b(enabled);

    // slug only if column exists
    let hasSlug = false;
    try {
      const { rows: slugCol } = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='slug' LIMIT 1"
      );
      hasSlug = slugCol.length > 0;
    } catch (_) {}
    let slug = slugifyLite(nm);
    if (hasSlug) {
      for (let i=2;i<100;i++){
        const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 LIMIT 1', [slug]);
        if (!rows.length) break;
        slug = slugifyLite(nm) + '-' + i;
      }
    }

    // next order index or sort
    let nextOrder = 0;
    let orderCol = null;
    try {
      const { rows } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_folders');
      nextOrder = Number(rows[0]?.next || 0); orderCol = 'order_index';
    } catch (_){
      try {
        const { rows } = await pool.query('SELECT COALESCE(MAX(sort),-1)+1 AS next FROM analytics_folders');
        nextOrder = Number(rows[0]?.next || 0); orderCol = 'sort';
      } catch (_){ nextOrder = 0; orderCol = null; }
    }

    // columns present
    const { rows: colRows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='analytics_folders'"
    );
    const colSet = new Set(colRows.map(r => r.column_name));

    const cols = []; const vals = []; const params = []; let i = 1;
    const add = (c, v) => { cols.push(c); vals.push('$' + (i++)); params.push(v); };

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

    const sql = 'INSERT INTO analytics_folders (' + cols.join(',') + ') VALUES (' + vals.join(',') + ') RETURNING *';
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

// Replace existing router.post('/folders', ...) block
const foldersRe = /router\.post\(\s*(['"])\/folders\1\s*,[\s\S]*?\n\}\);\s*/m;
if (foldersRe.test(src)) {
  src = src.replace(foldersRe, newFoldersRoute + "\n");
  console.log("✓ Replaced POST /folders route cleanly.");
} else {
  console.error("Could not locate POST /folders route to replace.");
  process.exit(1);
}

// Also fix any accidental broken "slug=" query leftovers
src = src.replace(/SELECT 1 FROM analytics_folders WHERE slug=['"]\s*LIMIT 1/g, "SELECT 1 FROM analytics_folders WHERE slug=$1 LIMIT 1");

// Write back
fs.writeFileSync(file, src, "utf8");
console.log("✓ File written:", file);
