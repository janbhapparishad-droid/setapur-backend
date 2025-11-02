const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }

let src = fs.readFileSync(file, "utf8");
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

let changed = false;

/* 1) Force-add authOptional at EOF if missing */
if (!/function\s+authOptional\s*\(/.test(src)) {
  const helper =
    "\n\n// --- authOptional: allow public access, use JWT if present ---\n" +
    "function authOptional(req, res, next) {\n" +
    "  try {\n" +
    "    const header = req.headers['authorization'];\n" +
    "    if (header) {\n" +
    "      const token = header.startsWith('Bearer ')\n" +
    "        ? header.slice(7).trim()\n" +
    "        : String(header).trim();\n" +
    "      const verified = jwt.verify(token, SECRET_KEY);\n" +
    "      verified.role = normRole(verified.role);\n" +
    "      verified.username = String(verified.username || '');\n" +
    "      req.user = verified;\n" +
    "    }\n" +
    "  } catch (_) { /* ignore */ }\n" +
    "  next();\n" +
    "}\n";
  src = src + helper;
  changed = true;
  console.log("✓ Added authOptional() at EOF");
}

/* 2) Ensure require('./routes/analyticsPublic') exists */
if (!/const\s+analyticsPublic\s*=\s*require\(\s*["']\.\/routes\/analyticsPublic["']\s*\)/.test(src)) {
  // Add near other route requires; fallback to top
  const routesHook = /const\s+analyticsAdminDB\s*=\s*require\(\s*["']\.\/routes\/analyticsAdminDB["']\s*\)\s*;\s*/;
  if (routesHook.test(src)) {
    src = src.replace(routesHook, (m) => m + 'const analyticsPublic = require("./routes/analyticsPublic");\n');
  } else {
    // Add after first require block or at top
    const anyRequire = /(^|\n)const\s+.*?=\s*require\([^\n]+\);\s*/;
    if (anyRequire.test(src)) {
      src = src.replace(anyRequire, (m) => m + '\nconst analyticsPublic = require("./routes/analyticsPublic");\n');
    } else {
      src = 'const analyticsPublic = require("./routes/analyticsPublic");\n' + src;
    }
  }
  changed = true;
  console.log("✓ Added require('./routes/analyticsPublic')");
}

/* 3) Ensure mount uses authOptional */
const publicMount = /app\.use\(\s*["']\/analytics\/public["']\s*,[\s\S]*?analyticsPublic\s*\)\s*;\s*/;
if (publicMount.test(src)) {
  // normalize
  src = src.replace(publicMount, 'app.use("/analytics/public", authOptional, analyticsPublic);\n');
  changed = true;
  console.log("✓ Normalized /analytics/public mount to authOptional");
} else {
  // Insert after admin mount, else after CORS
  const adminMount = /app\.use\(\s*["']\/analytics\/admin["'][\s\S]*?\)\s*;\s*/;
  if (adminMount.test(src)) {
    src = src.replace(adminMount, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
    changed = true;
    console.log("✓ Added /analytics/public mount after admin");
  } else {
    const corsMount = /app\.use\(\s*cors\(\)\s*\)\s*;\s*/;
    if (corsMount.test(src)) {
      src = src.replace(corsMount, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
      changed = true;
      console.log("✓ Added /analytics/public mount after CORS");
    } else {
      console.warn("~ Could not auto-insert /analytics/public mount; verify manually");
    }
  }
}

if (changed) {
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ server.js updated");
} else {
  console.log("~ No changes made (already correct)");
}
