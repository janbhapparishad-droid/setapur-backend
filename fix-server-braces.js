const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
  console.error("server.js not found");
  process.exit(1);
}
const backup = file.replace(/server\.js$/, `server.backup-braces-${Date.now()}.js`);
fs.copyFileSync(file, backup);

let src = fs.readFileSync(file, "utf8");

// 0) Remove any earlier injected analytics helper blocks if left
src = src.replace(/\/\*\s*===\s*ANALYTICS_ADMIN_[\s\S]*?END\s+ANALYTICS_ADMIN_[\s\S]*?\*\//g, "");

// 1) Disable legacy mounts
src = src.replace(/^\s*app\.use\s*\(\s*['"]\/analytics\/admin['"][\s\S]*?;\s*$/gmi, "// disabled legacy analytics mount");

// 2) Comment top-level await pool.query lines and top-level lone braces
const lines = src.split(/\r?\n/);
function scrubStringsAndLineComments(s){
  // Remove // comments and string literals for brace counting (rough but works)
  let out = s.replace(/\/\/.*$/,"");
  out = out.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ""); // remove quoted parts
  return out;
}
let depth = 0;
for (let i=0;i<lines.length;i++){
  const cur = lines[i];

  // Compute depth at start-of-this-line by scanning previous cleaned line
  // For accuracy across multiple braces, recompute from start up to i-1
  // (file is not too large)
  depth = 0;
  for (let k=0;k<i;k++){
    const prevClean = scrubStringsAndLineComments(lines[k]);
    for (const ch of prevClean){
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth-1);
    }
  }

  const trimmed = cur.trim();

  // Top-level await pool.query(...)
  if (depth === 0 && /await\s+pool\.query\(/.test(trimmed)) {
    lines[i] = "// removed stray top-level await: " + cur;
    continue;
  }

  // Top-level lone } or });
  if (depth === 0 && (/^\}$/.test(trimmed) || /^\}\s*;?$/.test(trimmed) || /^\}\)\s*;?$/.test(trimmed))) {
    lines[i] = "// removed stray top-level brace: " + cur;
    continue;
  }
}

// 3) Ensure our DB router mount exists once
let out = lines.join("\n");
if (!/routes\/analyticsAdminDB/.test(out)) {
  out += `

const analyticsAdminDB = require("./routes/analyticsAdminDB");
app.use("/analytics/admin", authRole(["admin","mainadmin"]), analyticsAdminDB);
`;
}

// 4) Normalize blank lines
out = out.replace(/(\r?\n){3,}/g, "\n\n");

fs.writeFileSync(file, out, "utf8");
console.log("Cleanup done. Backup:", path.basename(backup));
