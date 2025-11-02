const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }

let src = fs.readFileSync(file, "utf8");
// Backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

let changed = false;

// 1) Ensure authOptional exists (prepend if missing)
if (!/function\s+authOptional\s*\(/.test(src)) {
  const authOptionalText =
    "\nfunction authOptional(req, res, next) {\n" +
    "  try {\n" +
    "    const header = req.headers['authorization'];\n" +
    "    if (header) {\n" +
    "      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();\n" +
    "      const verified = jwt.verify(token, SECRET_KEY);\n" +
    "      verified.role = normRole(verified.role);\n" +
    "      verified.username = String(verified.username || '');\n" +
    "      req.user = verified;\n" +
    "    }\n" +
    "  } catch (_) { /* ignore invalid/missing token */ }\n" +
    "  next();\n" +
    "}\n";
  // Try to insert after Auth helpers comment if present; else prepend
  const marker = src.indexOf("/* ===================== Auth helpers");
  if (marker !== -1) {
    const insertAt = src.indexOf("\n", marker);
    src = src.slice(0, insertAt + 1) + authOptionalText + src.slice(insertAt + 1);
  } else {
    src = authOptionalText + src;
  }
  changed = true;
  console.log("✓ Added authOptional()");
}

// 2) Ensure analyticsPublic require
if (!/const\s+analyticsPublic\s*=\s*require\(\s*["']\.\/routes\/analyticsPublic["']\s*\)/.test(src)) {
  // Insert after analytics admin require if possible
  const adminReqRe = /const\s+analyticsAdminDB\s*=\s*require\(\s*["']\.\/routes\/analyticsAdminDB["']\s*\)\s*;\s*/;
  if (adminReqRe.test(src)) {
    src = src.replace(adminReqRe, (m) => m + 'const analyticsPublic = require("./routes/analyticsPublic");\n');
  } else {
    // Fallback: after app initialization or after other requires
    const firstApp = /const\s+app\s*=\s*express\(\)\s*;\s*/;
    if (firstApp.test(src)) {
      src = src.replace(firstApp, (m) => 'const analyticsPublic = require("./routes/analyticsPublic");\n' + m);
    } else {
      // prepend as last resort
      src = 'const analyticsPublic = require("./routes/analyticsPublic");\n' + src;
    }
  }
  changed = true;
  console.log("✓ Added require('./routes/analyticsPublic')");
}

// 3) Ensure /analytics/public mount with authOptional
const publicMountRe = /app\.use\(\s*["']\/analytics\/public["']\s*,[\s\S]*?analyticsPublic\s*\)\s*;\s*/;
if (publicMountRe.test(src)) {
  // Normalize to authOptional
  src = src.replace(publicMountRe, 'app.use("/analytics/public", authOptional, analyticsPublic);\n');
  changed = true;
  console.log("✓ Normalized /analytics/public mount to authOptional");
} else {
  // Insert after admin mount if exists
  const adminMountRe = /app\.use\(\s*["']\/analytics\/admin["'][\s\S]*?\)\s*;\s*/;
  if (adminMountRe.test(src)) {
    src = src.replace(adminMountRe, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
    changed = true;
    console.log("✓ Added /analytics/public mount after admin");
  } else {
    // Fallback: after CORS
    const corsRe = /app\.use\(\s*cors\(\)\s*\)\s*;\s*/;
    if (corsRe.test(src)) {
      src = src.replace(corsRe, (m) => m + '\napp.use("/analytics/public", authOptional, analyticsPublic);\n');
      changed = true;
      console.log("✓ Added /analytics/public mount after CORS");
    } else {
      console.warn("~ Could not find a good place to mount /analytics/public; please verify manually.");
    }
  }
}

if (changed) {
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ server.js patched");
} else {
  console.log("~ No changes needed in server.js");
}
