const fs = require("fs");
const path = require("path");
const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }
let src = fs.readFileSync(file, "utf8");
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// If already mounted, skip
if (src.includes('"/analytics/public"')) {
  console.log("~ /analytics/public already mounted");
  process.exit(0);
}

// Insert require + app.use after admin mount
const re = /app\.use\(\s*["']\/analytics\/admin["']\s*,[\s\S]*?\);\s*/m;
const inject = `
const analyticsPublic = require("./routes/analyticsPublic");
app.use("/analytics/public", authRole(['user','admin','mainadmin']), analyticsPublic);
`;
if (re.test(src)) {
  src = src.replace(re, (m) => m + "\n" + inject + "\n");
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ Mounted /analytics/public in server.js");
} else {
  // Fallback: append near top after app initialization
  const hook = /const app = express\(\);\s*[\s\S]*?app\.use\(cors\(\)\);\s*/m;
  if (hook.test(src)) {
    src = src.replace(hook, (m) => m + "\n" + inject + "\n");
    fs.writeFileSync(file, src, "utf8");
    console.log("✓ Mounted /analytics/public (fallback)");
  } else {
    console.error("Could not find a good place to inject in server.js");
    process.exit(1);
  }
}
