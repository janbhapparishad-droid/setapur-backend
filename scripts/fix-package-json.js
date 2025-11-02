const fs = require("fs");
const pkgPath = "package.json";

let raw = fs.readFileSync(pkgPath, "utf8");
// strip BOM if present
raw = raw.replace(/^\uFEFF/, "");
let pkg = {};
try {
  pkg = JSON.parse(raw);
} catch (e) {
  console.error("Failed to parse package.json:", e.message);
  process.exit(1);
}

pkg.scripts = pkg.scripts || {};
// Make start resilient on Render (run migration, then always start server)
pkg.scripts.start = "node scripts/analytics-migrate.js || echo 'migration: continuing' ; node server.js";

pkg.engines = pkg.engines || {};
pkg.engines.node = "22.x";

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("? package.json updated without BOM.");
