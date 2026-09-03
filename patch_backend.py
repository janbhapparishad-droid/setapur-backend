with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

s = '''app.get('/api/settings/live-stream', async (req, res) => {'''

api = '''// --- SOCIAL LINKS API ---
app.get('/api/settings/social-links', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM global_settings WHERE key = \', ['social_links']);
    if (rows.length > 0) {
      res.json({ links: JSON.parse(rows[0].value) });
    } else {
      res.json({ links: [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/social-links', authRole(['admin', 'mainadmin']), async (req, res) => {
  try {
    const { links } = req.body;
    await pool.query(
      'INSERT INTO global_settings (key, value) VALUES (\, \) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['social_links', JSON.stringify(links)]
    );
    res.json({ success: true, links });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings/live-stream', async (req, res) => {'''

if s in code:
    code = code.replace(s, api)
    with open('src/server.js', 'w', encoding='utf-8') as f:
        f.write(code)
    print("Backend API added successfully")
else:
    print("Could not find insertion block")
