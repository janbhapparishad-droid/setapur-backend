
// touch: categories-fix 2025-11-03T00:50:16
//
// === Categories: safe create override (appended) ===
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

// touch: categories-create-override 2025-11-03T01:03:07
