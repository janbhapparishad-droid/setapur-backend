const express = require("express");
const { Pool } = require("pg");

const crypto = require('crypto');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false }
});

function b(x){ return !(x===false||x==="false"||x===0||x==="0"); }
function slugifyLite(s){
  const raw = (String(s||"").toLowerCase().trim().normalize("NFKD")
    .replace(/[^\w\s-]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-")) || "";
  return raw || ("group-"+Date.now());
}

async function ensure(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      folder_id INT REFERENCES analytics_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      show_donation_detail BOOLEAN DEFAULT TRUE,
      show_expense_detail BOOLEAN DEFAULT TRUE,
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_folders_order ON analytics_folders(order_index, lower(name));
    CREATE INDEX IF NOT EXISTS idx_analytics_events_folder ON analytics_events(folder_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_order ON analytics_events(folder_id, order_index);
  `);
}

async function reorderFolders(folderId, direction, newIndex){
  const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(folderId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_folders SET order_index=$1 WHERE id=$2', [i, list[i]]);
}

async function reorderEvents(folderId, eventId, direction, newIndex){
  const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
  let list = rows.map(r => r.id);
  let idx = list.indexOf(Number(eventId));
  if (idx === -1) return;
  if (typeof newIndex === 'number' && Number.isFinite(newIndex)) {
    const it = list.splice(idx,1)[0];
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, it);
  } else if (direction === 'up' && idx > 0) {
    [list[idx-1], list[idx]] = [list[idx], list[idx-1]];
  } else if (direction === 'down' && idx < list.length - 1) {
    [list[idx+1], list[idx]] = [list[idx], list[idx+1]];
  }
  for (let i=0;i<list.length;i++) await pool.query('UPDATE analytics_events SET order_index=$1 WHERE id=$2', [i, list[i]]);
}

const router = express.Router();


/* Helper: resolve folder numeric id from id/uuid/slug/name */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function resolveFolderId(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
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

/* Folders list (with events) */
router.get('/folders', async (req,res)=>{
  try{
    await ensure();
    const { rows: folders } = await pool.query('SELECT id,name,slug,enabled,order_index FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    const out=[];
    for (const f of folders){
      const { rows: evs } = await pool.query(
        'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
        [f.id]
      );
      out.push({
        id:f.id, name:f.name, slug:f.slug, enabled:f.enabled, orderIndex:f.order_index,
        events: evs.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index }))
      });
    }
    res.json(out);
  }catch(e){ console.error('folders list err:',e); res.status(500).send('Failed to load analytics folders'); }
});

/* Create folder */


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
    const add = (c, v) => { cols.push(c); vals.push('/* Enable/disable folder */
router.post('/folders/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
});

/* Delete folder */
router.delete('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
});

/* Reorder folders */
router.post('/folders/reorder', async (req,res)=>{
  try{
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    await reorderFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

/* List events of folder */

router.get('/folders/:folderId/events', async (req,res)=>{
  try{
    const fid = await resolveFolderId(req.params.folderId);
    if (!fid) return res.status(404).json({ error: 'Folder not found' });
    const { rows } = await pool.query(
      'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=' ORDER BY order_index ASC, lower(name) ASC',
      [fid]
    );
    res.json(rows.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});
/* Create event */

router.post('/events', async (req,res)=>{
  try{
    const { folderId, folderUUID, folderSlug, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });

    const fid = await resolveFolderId(folderId ?? folderUUID ?? folderSlug);
    if (!fid) return res.status(400).json({ error:'folder not found' });

    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id='', [fid]);
    const next = Number(max[0]?.next || 0);

    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id,name,enabled,show_donation_detail,show_expense_detail,order_index) VALUES (',$2,$3,$4,$5,$6) RETURNING *',
      [fid, nm, b(enabled), b(showDonationDetail), b(showExpenseDetail), next]
    );
    return res.status(201).json(rows[0]);
  }catch(e){
    console.error('create event err:', e);
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Create event failed');
  }
});
/* Update/Enable/Delete event */
router.put('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){ fields.push(`name=$${i++}`); vals.push(nmIn); }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (showDonationDetail !== undefined){ fields.push(`show_donation_detail=$${i++}`); vals.push(b(showDonationDetail)); }
    if (showExpenseDetail !== undefined){ fields.push(`show_expense_detail=$${i++}`); vals.push(b(showExpenseDetail)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update event failed'); }
});

router.post('/events/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
});

router.delete('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
});

router.post('/events/reorder', async (req,res)=>{
  try{
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error:'folderId and eventId required' });
    await reorderEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder event err:', e); res.status(500).send('Reorder failed'); }
});

module.exports = router;
+(i++)); params.push(v); };

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

    const sql = `INSERT INTO analytics_folders (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`;
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
/* Update folder */
router.put('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){
      fields.push(`name=$${i++}`); vals.push(nmIn);
      let sl = slugifyLite(nmIn);
      for (let j=2;j<100;j++){ const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 AND id<>$2 LIMIT 1',[sl,id]); if(!rows.length) break; sl=`${slugifyLite(nmIn)}-${j}`; }
      fields.push(`slug=$${i++}`); vals.push(sl);
    }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_folders SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update folder err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update folder failed'); }
});

/* Enable/disable folder */
router.post('/folders/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
});

/* Delete folder */
router.delete('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
});

/* Reorder folders */
router.post('/folders/reorder', async (req,res)=>{
  try{
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    await reorderFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

/* List events of folder */
router.get('/folders/:folderId/events', async (req,res)=>{
  try{
    const { folderId } = req.params;
    const { rows } = await pool.query(
      'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
      [folderId]
    );
    res.json(rows.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});

/* Create event */
router.post('/events', async (req,res)=>{
  try{
    const { folderId, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [folderId]);
    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id,name,enabled,show_donation_detail,show_expense_detail,order_index) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [folderId, nm, b(enabled), b(showDonationDetail), b(showExpenseDetail), Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  }catch(e){ console.error('create event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Create event failed'); }
});

/* Update/Enable/Delete event */
router.put('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){ fields.push(`name=$${i++}`); vals.push(nmIn); }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (showDonationDetail !== undefined){ fields.push(`show_donation_detail=$${i++}`); vals.push(b(showDonationDetail)); }
    if (showExpenseDetail !== undefined){ fields.push(`show_expense_detail=$${i++}`); vals.push(b(showExpenseDetail)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update event failed'); }
});

router.post('/events/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
});

router.delete('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
});

router.post('/events/reorder', async (req,res)=>{
  try{
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error:'folderId and eventId required' });
    await reorderEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder event err:', e); res.status(500).send('Reorder failed'); }
});

module.exports = router;
 + (i++)); params.push(v); };

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

/* Enable/disable folder */
router.post('/folders/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
});

/* Delete folder */
router.delete('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
});

/* Reorder folders */
router.post('/folders/reorder', async (req,res)=>{
  try{
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    await reorderFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

/* List events of folder */

router.get('/folders/:folderId/events', async (req,res)=>{
  try{
    const fid = await resolveFolderId(req.params.folderId);
    if (!fid) return res.status(404).json({ error: 'Folder not found' });
    const { rows } = await pool.query(
      'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=' ORDER BY order_index ASC, lower(name) ASC',
      [fid]
    );
    res.json(rows.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});
/* Create event */

router.post('/events', async (req,res)=>{
  try{
    const { folderId, folderUUID, folderSlug, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });

    const fid = await resolveFolderId(folderId ?? folderUUID ?? folderSlug);
    if (!fid) return res.status(400).json({ error:'folder not found' });

    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id='', [fid]);
    const next = Number(max[0]?.next || 0);

    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id,name,enabled,show_donation_detail,show_expense_detail,order_index) VALUES (',$2,$3,$4,$5,$6) RETURNING *',
      [fid, nm, b(enabled), b(showDonationDetail), b(showExpenseDetail), next]
    );
    return res.status(201).json(rows[0]);
  }catch(e){
    console.error('create event err:', e);
    if ((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail });
    res.status(500).send('Create event failed');
  }
});
/* Update/Enable/Delete event */
router.put('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){ fields.push(`name=$${i++}`); vals.push(nmIn); }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (showDonationDetail !== undefined){ fields.push(`show_donation_detail=$${i++}`); vals.push(b(showDonationDetail)); }
    if (showExpenseDetail !== undefined){ fields.push(`show_expense_detail=$${i++}`); vals.push(b(showExpenseDetail)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update event failed'); }
});

router.post('/events/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
});

router.delete('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
});

router.post('/events/reorder', async (req,res)=>{
  try{
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error:'folderId and eventId required' });
    await reorderEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder event err:', e); res.status(500).send('Reorder failed'); }
});

module.exports = router;
+(i++)); params.push(v); };

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

    const sql = `INSERT INTO analytics_folders (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`;
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
/* Update folder */
router.put('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){
      fields.push(`name=$${i++}`); vals.push(nmIn);
      let sl = slugifyLite(nmIn);
      for (let j=2;j<100;j++){ const { rows } = await pool.query('SELECT 1 FROM analytics_folders WHERE slug=$1 AND id<>$2 LIMIT 1',[sl,id]); if(!rows.length) break; sl=`${slugifyLite(nmIn)}-${j}`; }
      fields.push(`slug=$${i++}`); vals.push(sl);
    }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_folders SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update folder err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update folder failed'); }
});

/* Enable/disable folder */
router.post('/folders/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_folders SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable folder err:', e); res.status(500).send('Enable folder failed'); }
});

/* Delete folder */
router.delete('/folders/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_folders WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete folder err:', e); res.status(500).send('Delete folder failed'); }
});

/* Reorder folders */
router.post('/folders/reorder', async (req,res)=>{
  try{
    const { folderId, direction, newIndex } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    await reorderFolders(Number(folderId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_folders ORDER BY order_index ASC, lower(name) ASC');
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder folder err:', e); res.status(500).send('Reorder failed'); }
});

/* List events of folder */
router.get('/folders/:folderId/events', async (req,res)=>{
  try{
    const { folderId } = req.params;
    const { rows } = await pool.query(
      'SELECT id,name,enabled,show_donation_detail,show_expense_detail,order_index FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, lower(name) ASC',
      [folderId]
    );
    res.json(rows.map(e=>({ id:e.id, name:e.name, enabled:e.enabled, showDonationDetail:e.show_donation_detail, showExpenseDetail:e.show_expense_detail, orderIndex:e.order_index })));
  }catch(e){ console.error('list events err:', e); res.status(500).send('Failed to load events'); }
});

/* Create event */
router.post('/events', async (req,res)=>{
  try{
    const { folderId, name, eventName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    if (!folderId) return res.status(400).json({ error:'folderId required' });
    const nm = String(eventName || name || '').trim();
    if (!nm) return res.status(400).json({ error:'name required' });
    const { rows: max } = await pool.query('SELECT COALESCE(MAX(order_index),-1)+1 AS next FROM analytics_events WHERE folder_id=$1', [folderId]);
    const { rows } = await pool.query(
      'INSERT INTO analytics_events (folder_id,name,enabled,show_donation_detail,show_expense_detail,order_index) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [folderId, nm, b(enabled), b(showDonationDetail), b(showExpenseDetail), Number(max[0]?.next||0)]
    );
    res.status(201).json(rows[0]);
  }catch(e){ console.error('create event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Create event failed'); }
});

/* Update/Enable/Delete event */
router.put('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { name, newName, enabled, showDonationDetail, showExpenseDetail } = req.body || {};
    const nmIn = String(newName || name || '').trim();
    const fields=[]; const vals=[]; let i=1;
    if (nmIn){ fields.push(`name=$${i++}`); vals.push(nmIn); }
    if (enabled !== undefined){ fields.push(`enabled=$${i++}`); vals.push(b(enabled)); }
    if (showDonationDetail !== undefined){ fields.push(`show_donation_detail=$${i++}`); vals.push(b(showDonationDetail)); }
    if (showExpenseDetail !== undefined){ fields.push(`show_expense_detail=$${i++}`); vals.push(b(showExpenseDetail)); }
    if (!fields.length) return res.status(400).json({ error:'No changes' });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE analytics_events SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json(rows[0]);
  }catch(e){ console.error('update event err:', e); if((e.code||'').startsWith('23')) return res.status(409).json({ error:'constraint', code:e.code, constraint:e.constraint, detail:e.detail }); res.status(500).send('Update event failed'); }
});

router.post('/events/:id/enable', async (req,res)=>{
  try{
    const { id } = req.params; const en = b(req.body?.enabled);
    const { rows } = await pool.query('UPDATE analytics_events SET enabled=$1 WHERE id=$2 RETURNING *', [en, id]);
    if (!rows.length) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true, id: rows[0].id, enabled: rows[0].enabled });
  }catch(e){ console.error('enable event err:', e); res.status(500).send('Enable event failed'); }
});

router.delete('/events/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM analytics_events WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  }catch(e){ console.error('delete event err:', e); res.status(500).send('Delete event failed'); }
});

router.post('/events/reorder', async (req,res)=>{
  try{
    const { folderId, eventId, direction, newIndex } = req.body || {};
    if (!folderId || !eventId) return res.status(400).json({ error:'folderId and eventId required' });
    await reorderEvents(Number(folderId), Number(eventId), direction, typeof newIndex==='number'?newIndex:undefined);
    const { rows } = await pool.query('SELECT id FROM analytics_events WHERE folder_id=$1 ORDER BY order_index ASC, id ASC', [folderId]);
    res.json({ ok:true, order: rows.map(r=>r.id) });
  }catch(e){ console.error('reorder event err:', e); res.status(500).send('Reorder failed'); }
});

module.exports = router;
