const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "routes", "analyticsAdminDB.js");
if (!fs.existsSync(file)) {
  console.error("routes/analyticsAdminDB.js not found");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");

// Backup first
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// Helper to replace a router block by regex
function replaceBlock(src, re, replacement, label){
  if (re.test(src)) {
    src = src.replace(re, replacement + "\n");
    console.log("✓ Replaced", label);
  } else {
    console.warn("~ Could not find", label, "to replace");
  }
  return src;
}

/* 1) Replace PUT /folders/:id block with concatenation-based version */
const putFoldersRe = /router\.put\(\s*(['"])\/folders\/:id\1\s*,[\s\S]*?\n\}\);\s*/m;
const putFoldersNew = `
router.put('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;

    if (nmIn){
      fields.push('name=$' + (i++)); vals.push(nmIn);

      // keep slug unique if column exists
      let hasSlug = false;
      try {
        const { rows } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='slug' LIMIT 1");
        hasSlug = rows.length > 0;
      } catch(_){}
      if (hasSlug){
        let sl = slugifyLite(nmIn);
        for (let j=2;j<100;j++){
          const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 AND id<>$2 LIMIT 1',[sl,id]);
          if(!rows.length) break; sl = slugifyLite(nmIn) + '-' + j;
        }
        fields.push('slug=$' + (i++)); vals.push(sl);
      }

      // legacy mirror to folder_name if present
      try {
        const { rows } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='analytics_folders' AND column_name='folder_name' LIMIT 1");
        if (rows.length){ fields.push('folder_name=$' + (i++)); vals.push(nmIn); }
      } catch(_){}
    }

    if (enabled !== undefined){ fields.push('enabled=$' + (i++)); vals.push(b(enabled)); }

    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);

    const sql = 'UPDATE analytics_folders SET ' + fields.join(', ') + ' WHERE id=$' + i + ' RETURNING *';
    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){
    console.error('update folder err:', e);
    if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Update folder failed');
  }
});
`;

/* 2) Replace PUT /events/:id block with concatenation-based version */
const putEventsRe = /router\.put\(\s*(['"])\/events\/:id\1\s*,[\s\S]*?\n\}\);\s*/m;
const putEventsNew = `
router.put('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;

    if (nmIn){ fields.push('name=$' + (i++)); vals.push(nmIn); }
    if (enabled !== undefined){ fields.push('enabled=$' + (i++)); vals.push(b(enabled)); }
    if (showDonationDetail !== undefined){ fields.push('show_donation_detail=$' + (i++)); vals.push(b(showDonationDetail)); }
    if (showExpenseDetail !== undefined){ fields.push('show_expense_detail=$' + (i++)); vals.push(b(showExpenseDetail)); }

    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);

    const sql = 'UPDATE analytics_events SET ' + fields.join(', ') + ' WHERE id=$' + i + ' RETURNING *';
    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){
    console.error('update event err:', e);
    if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Update event failed');
  }
});
`;

/* 3) Apply replacements */
src = replaceBlock(src, putFoldersRe, putFoldersNew, "PUT /folders/:id");
src = replaceBlock(src, putEventsRe, putEventsNew, "PUT /events/:id");

// 4) Also sanitize any stray backslash-backtick and \$\{ sequences that might remain
src = src.replace(/\\`/g, '`').replace(/\$\\\{/g, '${');

// Write file back
fs.writeFileSync(file, src, "utf8");
console.log("✓ Patched analyticsAdminDB.js successfully.");
