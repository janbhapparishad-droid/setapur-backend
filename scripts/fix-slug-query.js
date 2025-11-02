const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "routes", "analyticsAdminDB.js");
if (!fs.existsSync(file)) {
  console.error("routes/analyticsAdminDB.js not found");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");

// Backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// Fix the broken query: it became slug=' LIMIT 1 due to $1 replacement in String.replace
const bad = "SELECT 1 FROM analytics_folders WHERE slug=' LIMIT 1";
const good = "SELECT 1 FROM analytics_folders WHERE slug=$1 LIMIT 1";

if (src.includes(bad)) {
  src = src.replace(bad, good);
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ Fixed slug query to use parameter $1.");
} else {
  // Try a more general regex in case of minor variations
  const re = /SELECT 1 FROM analytics_folders WHERE slug=['"]\s*LIMIT 1/;
  if (re.test(src)) {
    src = src.replace(re, good);
    fs.writeFileSync(file, src, "utf8");
    console.log("✓ Fixed slug query via regex.");
  } else {
    console.log("~ No broken slug query found; nothing to change.");
  }
}
