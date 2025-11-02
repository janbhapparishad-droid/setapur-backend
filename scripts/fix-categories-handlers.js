const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }

let src = fs.readFileSync(file, "utf8");
// Backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// Replace listCategoriesHandler
const listRe = /const\s+listCategoriesHandler\s*=\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{[\s\S]*?\}\s*;\s*/m;
const listNew =
  "const listCategoriesHandler = async (req, res) => {\n" +
  "  try {\n" +
  "    await ensureCategoriesTable();\n" +
  "    const role = req.user?.role || 'user';\n" +
  "    const isAdmin = role === 'admin' || role === 'mainadmin';\n" +
  "    const includeDisabled = ['1','true'].includes(String(req.query.includeDisabled || '').toLowerCase());\n" +
  "    let sql = 'SELECT id, name, enabled, created_at FROM categories';\n" +
  "    if (!isAdmin && !includeDisabled) sql += ' WHERE enabled = true';\n" +
  "    sql += ' ORDER BY lower(name) ASC';\n" +
  "    const { rows } = await pool.query(sql);\n" +
  "    res.json(rows);\n" +
  "  } catch (e) {\n" +
  "    console.error('categories list error:', e);\n" +
  "    res.status(500).send('Failed to list categories');\n" +
  "  }\n" +
  "};\n";

if (listRe.test(src)) {
  src = src.replace(listRe, listNew);
  console.log("✓ Patched listCategoriesHandler");
} else {
  console.warn("~ Could not locate listCategoriesHandler; verify server.js layout");
}

// Replace createCategoryHandler
const createRe = /const\s+createCategoryHandler\s*=\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{[\s\S]*?\}\s*;\s*/m;
const createNew =
  "const createCategoryHandler = async (req, res) => {\n" +
  "  try {\n" +
  "    await ensureCategoriesTable();\n" +
  "    const { name, enabled } = req.body || {};\n" +
  "    const nm = String(name || '').trim();\n" +
  "    if (!nm) return res.status(400).json({ error: 'name required' });\n" +
  "    const en = !(enabled === false || enabled === 'false' || enabled === 0 || enabled === '0');\n" +
  "    const { rows } = await pool.query(\n" +
  "      'INSERT INTO categories (name, enabled) VALUES ($1, $2) RETURNING id, name, enabled, created_at',\n" +
  "      [nm, en]\n" +
  "    );\n" +
  "    res.status(201).json(rows[0]);\n" +
  "  } catch (e) {\n" +
  "    if ((e.code || '').startsWith('23')) return res.status(409).json({ error: 'category already exists' });\n" +
  "    console.error('categories create error:', e);\n" +
  "    res.status(500).send('Create failed');\n" +
  "  }\n" +
  "};\n";

if (createRe.test(src)) {
  src = src.replace(createRe, createNew);
  console.log("✓ Patched createCategoryHandler");
} else {
  console.warn("~ Could not locate createCategoryHandler; verify server.js layout");
}

// Write back
fs.writeFileSync(file, src, "utf8");
console.log("✓ server.js updated (categories handlers)");
