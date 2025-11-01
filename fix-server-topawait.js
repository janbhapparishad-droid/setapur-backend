const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
  console.error("server.js not found");
  process.exit(1);
}
const backup = file.replace(/server\.js$/, `server.backup-topawait-${Date.now()}.js`);
fs.copyFileSync(file, backup);

let src = fs.readFileSync(file, "utf8");

// Remove earlier injected analytics blocks (if any)
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_GLOBAL_FIX_v2[\s\S]*?END\s+ANALYTICS_ADMIN_GLOBAL_FIX_v2\s*\*\//g, "");
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_GLOBAL_FIX[\s\S]*?END\s+ANALYTICS_ADMIN_GLOBAL_FIX\s*\*\//g, "");
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_NS_BEGIN[\s\S]*?ANALYTICS_ADMIN_NS_END\s*\*\//g, "");
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_ROUTES_BEGIN[\s\S]*?ANALYTICS_ADMIN_ROUTES_END\s*\*\//g, "");

// Remove dedup leftovers
src = src.split(/\r?\n/).filter(l => !/dedup:/.test(l)).join("\n");

// Disable legacy mounts
src = src.replace(/^\s*app\.use\s*\(\s*['"]\/analytics\/admin['"][\s\S]*?;\s*$/gmi, "// disabled legacy analytics mount");

// Comment known top-level await lines (SELECT/UPDATE order_index, or for(... ) await pool.query)
const arr = src.split(/\r?\n/);
const reSelectRows = /^\s*const\s+\{\s*rows\s*\}\s*=\s*await\s+pool\.query\(\s*'SELECT\s+id\s+FROM\s+analytics_(folders|events)[^']*'\s*.*$/;
const reSelectAwait = /^\s*await\s+pool\.query\(\s*'SELECT\s+id\s+FROM\s+analytics_(folders|events)[^']*'\s*.*$/;
const reUpdateOrder = /^\s*await\s+pool\.query\(\s*'UPDATE\s+analytics_(folders|events)\s+SET\s+order_index[^']*'\s*,\s*\[.*\]\s*\);\s*$/;
const reForAwait = /^\s*for\s*\([^)]*\)\s*await\s+pool\.query\(/;

let patched = 0;
for (let i = 0; i < arr.length; i++) {
  const l = arr[i];
  if (reSelectRows.test(l) || reSelectAwait.test(l) || reUpdateOrder.test(l) || reForAwait.test(l)) {
    arr[i] = "// removed stray top-level await: " + l;
    patched++;
  }
}

// Also drop duplicate function bodies if any remain
let out = arr.join("\n")
  .replace(/async\s+function\s+ensureAnalyticsConfigTables\s*\([^)]*\)\s*\{[\s\S]*?\}\s*/g, "/* removed duplicate ensureAnalyticsConfigTables */")
  .replace(/async\s+function\s+reorderAnalyticsFolders\s*\([^)]*\)\s*\{[\s\S]*?\}\s*/g, "/* removed duplicate reorderAnalyticsFolders */")
  .replace(/async\s+function\s+reorderAnalyticsEvents\s*\([^)]*\)\s*\{[\s\S]*?\}\s*/g, "/* removed duplicate reorderAnalyticsEvents */");

// Ensure our DB router mount exists once
if (!/routes\/analyticsAdminDB/.test(out)) {
  out += `

const analyticsAdminDB = require("./routes/analyticsAdminDB");
app.use("/analytics/admin", authRole(["admin","mainadmin"]), analyticsAdminDB);
`;
}

// Normalize multiple blank lines
out = out.replace(/(\r?\n){3,}/g, "\n\n");

fs.writeFileSync(file, out, "utf8");
console.log(\`Patched \${patched} stray await lines. Backup: \${path.basename(backup)}\`);
