const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
  console.error("server.js not found");
  process.exit(1);
}
const backup = file.replace(/server\.js$/, `server.backup-fullclean-${Date.now()}.js`);
fs.copyFileSync(file, backup);

let src = fs.readFileSync(file, "utf8");

// Remove any earlier injected analytics blocks (safe)
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_[\s\S]*?END\s+ANALYTICS_ADMIN_[\s\S]*?\*\//g, "");

// Remove dedup leftovers
src = src.split(/\r?\n/).filter(l => !/dedup:/.test(l)).join("\n");

// Disable legacy /analytics/admin mounts
src = src.replace(/^\s*app\.use\s*\(\s*['"]\/analytics\/admin['"][\s\S]*?;\s*$/gmi, "// disabled legacy analytics mount");

// Depth-based sanitizer
function stripStringsAndLineComments(s){
  let t = s.replace(/\/\/.*$/,"");
  t = t.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ""); // remove quoted parts
  return t;
}
const lines = src.split(/\r?\n/);
let depth = 0;
let patched = 0;

for (let i=0;i<lines.length;i++){
  const cur = lines[i];

  // Compute depth at start-of-this-line by scanning previous line only
  // Keep depth incrementally
  if (i > 0) {
    const prevClean = stripStringsAndLineComments(lines[i-1]);
    for (const ch of prevClean){
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth-1);
    }
  }

  const trimmed = cur.trim();
  const isTop = depth === 0;

  // Patterns to nuke at top-level
  const pAwait = /await\s+pool\.query\(/.test(trimmed);
  const pSelectRows = /^\s*const\s+\{\s*rows\s*\}\s*=\s*await\s+pool\.query\(/.test(trimmed);
  const pForAwait = /^\s*for\s*\([^)]*\)\s*await\s+pool\.query\(/.test(trimmed);
  const pLetList = /^\s*(let|const)\s+list\s*=/.test(trimmed);   // let list = rows.map...
  const pLetIdx  = /^\s*(let|const)\s+idx\s*=/.test(trimmed);    // let idx = list.indexOf...
  const pRowsMap = /^\s*(let|const)\s+\w+\s*=\s*rows\.map\(/.test(trimmed);
  const pIfIdx   = /^\s*if\s*\(\s*idx\s*===\s*-1\s*\)\s*return;/.test(trimmed);
  const pIfNewIx = /^\s*if\s*\(\s*typeof\s+newIndex/.test(trimmed);
  const pElseDir = /^\s*else\s+if\s*\(\s*direction\s*===/.test(trimmed);
  const pUpdOrd  = /^\s*await\s+pool\.query\(\s*'UPDATE\s+analytics_(folders|events)\s+SET\s+order_index/.test(trimmed);
  const pStrayBrace = (/^\}$/.test(trimmed) || /^\}\s*;?$/.test(trimmed) || /^\}\)\s*;?$/.test(trimmed));

  if (isTop && (pSelectRows || pForAwait || pLetList || pLetIdx || pRowsMap || pIfIdx || pIfNewIx || pElseDir || pUpdOrd)) {
    lines[i] = "// removed stray top-level code: " + cur;
    patched++;
    continue;
  }
  if (isTop && pAwait) {
    lines[i] = "// removed stray top-level await: " + cur;
    patched++;
    continue;
  }
  if (isTop && pStrayBrace) {
    lines[i] = "// removed stray top-level brace: " + cur;
    patched++;
    continue;
  }
}

let out = lines.join("\n");

// Ensure DB router mount exists once
if (!/routes\/analyticsAdminDB/.test(out)) {
  out += `

const analyticsAdminDB = require("./routes/analyticsAdminDB");
app.use("/analytics/admin", authRole(["admin","mainadmin"]), analyticsAdminDB);
`;
}

// Normalize multiple blank lines
out = out.replace(/(\r?\n){3,}/g, "\n\n");

fs.writeFileSync(file, out, "utf8");
console.log("Full clean done. Patched lines:", patched, "Backup:", path.basename(backup));
