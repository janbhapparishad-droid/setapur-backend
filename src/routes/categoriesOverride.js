module.exports = function(app, pool, ensureCategoriesTable, authRole, authOptional) {
  async function createCategory(req, res) {
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
  }

  // Create on multiple paths (alias friendly)
  ['/api/admin/categories', '/api/admin/categories/create', '/api/admin/categories/create-safe'].forEach((p) => {
    app.post(p, authRole(['admin','mainadmin']), createCategory);
  });

  // Public enabled-only list
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
};
