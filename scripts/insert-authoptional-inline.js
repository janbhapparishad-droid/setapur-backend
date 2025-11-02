const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) { console.error("server.js not found"); process.exit(1); }

let src = fs.readFileSync(file, "utf8");
// Backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

let changed = false;

// already has a definition?
const hasDef = /function\s+authOptional\s*\(|const\s+authOptional\s*=/.test(src);

// Find the public mount line
const mountRe = /(app\.use\(\s*["']\/analytics\/public["'][\s\S]*?analyticsPublic\s*\)\s*;\s*)/;
const m = src.match(mountRe);

if (m) {
  if (!hasDef) {
    const def =
      "\n// -- added: authOptional (optional JWT middleware for public endpoints)\n" +
      "const authOptional = (req, res, next) => {\n" +
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
      "};\n\n";

    // inject definition immediately before the mount line
    src = src.replace(mountRe, def + m[1]);
    changed = true;
    console.log("✓ Inserted authOptional definition above public mount");
  } else {
    console.log("~ authOptional already defined");
  }

  // Normalize mount to use authOptional (in case it's different)
  src = src.replace(mountRe, 'app.use("/analytics/public", authOptional, analyticsPublic);\n');
  changed = true;
  console.log("✓ Normalized public mount to authOptional");
} else {
  console.error("Could not find app.use(\"/analytics/public\", ...) in server.js");
  process.exit(1);
}

if (changed) {
  fs.writeFileSync(file, src, "utf8");
  console.log("✓ server.js updated");
} else {
  console.log("~ No changes made");
}
