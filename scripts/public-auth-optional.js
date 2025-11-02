const fs = require("fs");
const path = require("path");
const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
  console.error("server.js not found");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");

// Backup
fs.writeFileSync(file + ".bak." + Date.now(), src, "utf8");

// 1) Insert authOptional helper if missing (right after authRole or after auth helpers)
if (!/function\s+authOptional\s*\(/.test(src)) {
  const anchor = /function\s+authRole\s*\([\s\S]*?\}\s*\n/; // after authRole definition
  const helper = `
function authOptional(req, res, next) {
  try {
    const header = req.headers['authorization'];
    if (header) {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
      const verified = jwt.verify(token, SECRET_KEY);
      verified.role = normRole(verified.role);
      verified.username = String(verified.username || '');
      req.user = verified;
    }
  } catch (_) { /* ignore bad/missing token */ }
  next();
}
`;
  if (anchor.test(src)) {
    src = src.replace(anchor, m => m + helper + "\n");
    console.log("✓ Inserted authOptional after authRole");
  } else {
    // fallback: append near "Auth helpers" section
    const authHead = /\/\*\s*====================\s*Auth helpers[\s\S]*?\*\//;
    if (authHead.test(src)) {
      src = src.replace(authHead, m => m + helper + "\n");
      console.log("✓ Inserted authOptional near Auth helpers");
    } else {
      // last resort: append at top-level
      src = src + "\n" + helper + "\n";
      console.log("~ Appended authOptional at EOF");
    }
  }
}

// 2) Replace /analytics/public mount to use authOptional
const mountRe = /app\.use\(\s*["']\/analytics\/public["']\s*,\s*authRole\([\s\S]*?\)\s*,\s*analyticsPublic\s*\)\s*;\s*/;
if (mountRe.test(src)) {
  src = src.replace(mountRe, 'app.use("/analytics/public", authOptional, analyticsPublic);\n');
  console.log("✓ Switched /analytics/public to authOptional");
} else {
  // Try to detect an existing public mount without authRole (skip) or add mount if missing
  if (!/app\.use\(\s*["']\/analytics\/public["']/.test(src)) {
    // Insert after admin mount
    const adminMount = /app\.use\(\s*["']\/analytics\/admin["'][\s\S]*?\)\s*;\s*/;
    const inject = `
const analyticsPublic = require("./routes/analyticsPublic");
app.use("/analytics/public", authOptional, analyticsPublic);
`;
    if (adminMount.test(src)) {
      src = src.replace(adminMount, m => m + "\n" + inject + "\n");
      console.log("✓ Added /analytics/public mount with authOptional");
    } else {
      // Fallback: append after app.use(cors())
      const corsMount = /app\.use\(\s*cors\(\)\s*\)\s*;\s*/;
      if (corsMount.test(src)) {
        src = src.replace(corsMount, m => m + "\nconst analyticsPublic = require(\"./routes/analyticsPublic\");\napp.use(\"/analytics/public\", authOptional, analyticsPublic);\n");
        console.log("✓ Mounted /analytics/public after CORS");
      } else {
        console.warn("~ Could not find a neat spot to mount /analytics/public; leaving file unchanged for mount.");
      }
    }
  } else {
    console.log("~ /analytics/public mount not using authRole; leaving as-is");
  }
}

// Write back
fs.writeFileSync(file, src, "utf8");
console.log("✓ server.js patched");
