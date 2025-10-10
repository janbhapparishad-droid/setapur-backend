// models/analyticsStore.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const filePath = path.join(dataDir, 'analyticsFolders.json');

function readFolders() {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

function writeFolders(folders) {
  fs.writeFileSync(filePath, JSON.stringify(folders, null, 2), 'utf-8');
}

module.exports = { readFolders, writeFolders };