const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "server.js");
if (!fs.existsSync(file)) {
console.error("server.js not found");
process.exit(1);
}
const backup = file.replace(/server.js
/
,
‘
s
e
r
v
e
r
.
b
a
c
k
u
p
−
t
r
i
m
−
/,‘server.backup−trim−{Date.now()}.js`);
fs.copyFileSync(file, backup);

let src = fs.readFileSync(file, "utf8");

// 1) Find the LAST occurrence of 'start();' and trim everything after it
const lastIdx = src.lastIndexOf("start();");
if (lastIdx === -1) {
console.error("Could not find 'start();' in server.js. Aborting.");
process.exit(1);
}
// Position right after that line
const lineEnd = src.indexOf("\n", lastIdx);
let head = src.slice(0, lineEnd === -1 ? src.length : lineEnd + 1);

// 2) Disable any legacy /analytics/admin mounts inside kept part
head = head.replace(
/^\sapp.use\s(\s*['"]/analytics/admin['"][\s\S]?;\s$/gmi,
"// disabled legacy analytics mount"
);

// 3) Ensure clean DB router is mounted ONCE before start();
const routerPath = path.join(process.cwd(), "routes", "analyticsAdminDB.js");
const hasRouter = fs.existsSync(routerPath);
const hasMount = /routes/analyticsAdminDB/.test(head);

if (hasRouter && !hasMount) {
const mount = const analyticsAdminDB = require("./routes/analyticsAdminDB"); app.use("/analytics/admin", authRole(["admin","mainadmin"]), analyticsAdminDB);;
head = head.replace("start();", mount + "\nstart();");
}

// 4) Normalize excessive blank lines
head = head.replace(/(\r?\n){3,}/g, "\n\n");

// 5) Save
fs.writeFileSync(file, head, "utf8");
console.log("Trim complete. Backup saved as:", path.basename(backup));
