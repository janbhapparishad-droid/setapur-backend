const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "routes", "analyticsAdminDB.js");
if (!fs.existsSync(file)) {
  console.error("routes/analyticsAdminDB.js not found");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");

// backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// 1) Inject resolveFolderId helper after "const router = express.Router();" if not present
if (!/async function resolveFolderId\s*\(/.test(src)) {
  const injectAfter = /const\s+router\s*=\s*express\.Router\(\s*\)\s*;\s*/;
  if (injectAfter.test(src)) {
    const helper = `
/* Helper: resolve folder numeric id from id/uuid/slug/name */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function resolveFolderId(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\\d+$/.test(s)) return Number(s);
  if (UUID_RE.test(s)) {
    try {
      const { rows } = await pool.query('SELECT id FROM analytics_folders WHERE folder_id=$1', [s]);
      if (rows.length) return rows[0].id;
    } catch (_) {}
  }
  try {
    const bySlug = await pool.query('SELECT id FROM analytics_folders WHERE slug=$1', [s]);
    if (bySlug.rows.length) return bySlug.rows[0].id;
  } catch (_){}
  try {
    const byName = await pool.query('SELECT id FROM analytics_folders WHERE lower(name)=lower($1)', [s]);
    if (byName.rows.length) return byName.rows[0].id;
  } catch (_){}
  return null;
}
`;
    src = src.replace(injectAfter, m => m + helper + "\n");
  }
}

// 2) Replace POST /events to use resolveFolderId
const postEventsRe = /router\.post\(\s*(['"])\/events\1\s*,[\s\S]*?\n\}\);\s*/m;
if (postEventsRe.test(src)) {
  const postEventsNew = `
router.post('/events', async (req,res)=>{
  try{
    const { folderId, folderUUID, folderSlug, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });

    const fid = await resolveFolderId(folderId ?? folderUUID ?? folderSlug);
    if (!fid) return res.status(400).json({ error:'folder not found' });

    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [fid]);
    const next = Number(max[0]?.next || 0);

    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id,name,enabled,show_donation_detail,show_expense_detail,order_index) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [fid, nm, b(enabled), b(showDonationDetail), b(showExpenseDetail), next]
    );
    return res.status(201).json(rows[0]);
  }catch(e){
    console.error('create event err:', e);
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Create event failed');
  }
});
`;
  src = src.replace(postEventsRe, postEventsNew);
} else {
  console.warn("~ Could not find POST /events block to replace.");
}

// 3) Replace GET /folders/:folderId/events to resolve param too (optional but helpful)
const getEventsRe = /router\.get\(\s*(['"])\/folders\/:folderId\/events\1\s*,[\s\S]*?\n\}\);\s*/m;
if (getEventsRe.test(src)) {
  const getEventsNew = `
router.get('/folders/:folderId/events', async (req,res)=>{
  try{
    const fid = await resolveFolderId(req.params.folderId);
    if (!fid) return res.status(404).json({ error: 'Folder not found' });
    const { rows } = await pool.query(
      'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
      [fid]
    );
    res.json(rows.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});
`;
  src = src.replace(getEventsRe, getEventsNew);
}

fs.writeFileSync(file, src, "utf8");
console.log("✓ Events routes patched.");
