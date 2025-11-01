const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
  console.error("server.js not found");
  process.exit(1);
}
const backup = file.replace(/server\.js$/, `server.backup-sanitize-${Date.now()}.js`);
fs.copyFileSync(file, backup);

let src = fs.readFileSync(file, "utf8");

// Remove any previously injected analytics markers blocks (if any)
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_[\s\S]*?END\s+ANALYTICS_ADMIN_[\s\S]*?\*\//g, "");

// Remove dedup leftovers
src = src.split(/\r?\n/).filter(l => !/dedup:/.test(l)).join("\n");

// Disable legacy mounts
src = src.replace(/^\s*app\.use\s*\(\s*['"]\/analytics\/admin['"][\s\S]*?;\s*$/gmi, "// disabled legacy analytics mount");

// Helper: strip //comments and quoted strings for brace counting
function scrubForDepth(s){
  let t = s.replace(/\/\/.*$/,"");
  t = t.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "");
  return t;
}

// Comment top-level stray lines (no top-level await/decls)
const arr = src.split(/\r?\n/);
let depth = 0;
for (let i=0; i<arr.length; i++){
  // compute depth BEFORE processing this line by scanning previous line only
  // maintain depth incrementally
  const prev = i>0 ? scrubForDepth(arr[i-1]) : "";
  for (const ch of prev){
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth-1);
  }

  const line = arr[i];
  const trimmed = line.trim();

  const isTop = depth === 0;

  const badAwait = /await\s+pool\.query\(/.test(trimmed);
  const badSelectRows = /^\s*const\s+\{\s*rows\s*\}\s*=\s*await\s+pool\.query\(/.test(trimmed);
  const badForAwait = /^\s*for\s*\([^)]*\)\s*await\s+pool\.query\(/.test(trimmed);
  const badListDecl = /^\s*(let|const)\s+list\s*=/.test(trimmed);
  const badIdxDecl  = /^\s*(let|const)\s+idx\s*=/.test(trimmed);
  const badRowsMap  = /^\s*(let|const)\s+\w+\s*=\s*rows\.map\(/.test(trimmed);
  const strayBrace  = (/^\}$/.test(trimmed) || /^\}\s*;?$/.test(trimmed) || /^\}\)\s*;?$/.test(trimmed));

  if (isTop && (badAwait || badSelectRows || badForAwait || badListDecl || badIdxDecl || badRowsMap || strayBrace)) {
    arr[i] = "// removed stray top-level code: " + line;
  }
}

let out = arr.join("\n");

// Ensure our new router is mounted once
if (!/routes\/analyticsAdminDB/.test(out)) {
  out += `

const analyticsAdminDB = require("./routes/analyticsAdminDB");
app.use("/analytics/admin", authRole(["admin","mainadmin"]), analyticsAdminDB);
`;
}

// Normalize excessive blank lines
out = out.replace(/(\r?\n){3,}/g, "\n\n");

fs.writeFileSync(file, out, "utf8");
console.log("Sanitize done. Backup:", path.basename(backup));
