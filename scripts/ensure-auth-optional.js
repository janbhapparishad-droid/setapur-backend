const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }

let src = fs.readFileSync(file, "utf8");
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

let changed = false;

// 1) Force-define authOptional if not present
if (!/function\s+authOptional\s*\(/.test(src) && !/const\s+authOptional\s*=/.test(src)) {
  const helper =
    "\n\n// --- added: authOptional (public endpoints accept optional JWT) ---\n" +
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
    "  } catch (_) { /* ignore invalid/missing token */ }\n" +
    "  next();\n" +
    "}\n";
  // Try to add near Auth helpers; else append
  const hook = src.indexOf("/* ===================== Auth helpers");
  if (hook >= 0) {
    const nl = src.indexOf("\n", hook);
    src = src.slice(0, nl + 1) + helper + src.slice(nl + 1);
  } else {
    src = src + helper;
  }
  changed = true;
  console.log("✓ Added authOptional()");
}

// 2) Ensure require('./routes/analyticsPublic')
if (!/const\s+analyticsPublic\s*=\s*require\(\s*["']\.\/routes\/analyticsPublic["']\s*\)/.test(src)) {
  const adminReq = /const\s+analyticsAdminDB\s*=\s*require\(\s*["']\.\/routes\/analyticsAdminDB["']\s*\)\s*;\s*/;
  if (adminReq.test(src)) {
    src = src.replace(adminReq, (m) => m + 'const analyticsPublic = require("./routes/analyticsPublic");\n');
  } else {
    // fallback: after first require
    const anyReq = /(^|\n)const\s+.*?=\s*require\([^\n]+\);\s*/;
    if (anyReq.test(src)) src = src.replace(anyReq, (m)=> m + '\nconst analyticsPublic = require("./routes/analyticsPublic");\n');
    else src = 'const analyticsPublic = require("./routes/analyticsPublic");\n' + src;
  }
  changed = true;
  console.log("✓ Added require('./routes/analyticsPublic')");
}

// 3) Ensure mount uses authOptional
const mountRe = /app\.use\(\s*["']\/analytics\/public["']\s*,[\s\S]*?analyticsPublic\s*\)\s*;\s*/;
if (mountRe.test(src)) {
  src = src.replace(mountRe, 'app.use("/analytics/public", authOptional, analyticsPublic);\n');
  changed = true;
  console.log("✓ Normalized /analytics/public to authOptional");
} else {
  // insert after admin mount or after cors
  const adminMount = /app\.use\(\s*["']\/analytics\/admin["'][\s\S]*?\)\s*;\s*/;
  if (adminMount.test(src)) {
    src = src.replace(adminMount, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
    changed = true;
    console.log("✓ Added /analytics/public after admin mount");
  } else {
    const corsMount = /app\.use\(\s*cors\(\)\s*\)\s*;\s*/;
    if (corsMount.test(src)) {
      src = src.replace(corsMount, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
      changed = true;
      console.log("✓ Added /analytics/public after CORS");
    }
  }
}

if (changed) {
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ server.js patched");
} else {
  console.log("~ No changes needed");
}
