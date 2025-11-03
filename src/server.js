
// touch: categories-fix 2025-11-03T00:50:16

// touch: categories-create-fix 2025-11-03T01:07:27
//
// === Categories: safe create (override) ===
try {
  app.post('/api/admin/categories', authRole(['admin','mainadmin']), async (req, res) => {
    try {
      await ensureCategoriesTable();
      const nm = (req.body?.name ?? '').toString().trim();
      if (!nm) return res.status(400).json({ error: 'name required' });

      // Case-insensitive duplicate check
      const { rows: dup } = await pool.query(
        'SELECT 1 FROM categories WHERE lower(name) = lower() LIMIT 1', [nm]
      );
      if (dup.length) return res.status(409).json({ error: 'category already exists' });

      // Minimal insert; enabled uses DB default TRUE
      const { rows } = await pool.query(
        'INSERT INTO categories(name) VALUES () RETURNING id, name, enabled, created_at',
        [nm]
      );
      return res.status(201).json(rows[0]);
    } catch (e) {
      console.error('categories create error:', e);
      return res.status(500).json({ error: 'Create failed', code: e.code || null, detail: e.message || String(e) });
    }
  });
} catch (e) {
  console.warn('categories create route not mounted:', e.message);
}

// === Categories: enabled-only list (public) ===
try {
  app.get('/public/categories', authOptional, async (req, res) => {
    try {
      await ensureCategoriesTable();
      const { rows } = await pool.query(
        'SELECT id, name FROM categories WHERE enabled = true ORDER BY lower(name) ASC'
      );
      res.json(rows);
    } catch (e) {
      console.error('public categories list error:', e);
      res.status(500).send('Failed to list categories');
    }
  });
} catch (e) {
  console.warn('public categories route not mounted:', e.message);
}

// === Boot guard: ensure server listens even if start() missing ===
try {
  if (!global.__BOOT_GUARD__) {
    global.__BOOT_GUARD__ = true;
    const PORT = parseInt(process.env.PORT || '10000', 10);
    const HOST = '0.0.0.0';
    if (app && typeof app.listen === 'function') {
      // add a simple health endpoint
      try { app.get('/healthz', (_req, res) => res.status(200).send('ok')); } catch (_){}
      let listening = false;
      try {
        const srv = app.listen(PORT, HOST, () => {
          listening = true;
          console.log('Server listening on http://' + HOST + ':' + PORT);
        });
      } catch (e) {
        if (!listening) {
          console.error('Boot guard listen error:', e);
          process.exit(1);
        }
      }
    } else {
      console.error('Boot guard: app is not available');
      process.exit(1);
    }
  }
} catch (e) {
  console.error('Boot guard error:', e);
  process.exit(1);
}

// touch: categories-create-override " + (Get-Date -Format s) + @"
try { require('./routes/categoriesOverride')(app, pool, ensureCategoriesTable, authRole, authOptional); } catch (e) { console.warn('categories override not mounted:', e.message); }
