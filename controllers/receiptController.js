// controllers/receiptcontroller.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const filePath = path.join(dataDir, 'donations.json');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function loadDonations() {
  try {
    if (fs.existsSync(filePath)) {
      const txt = fs.readFileSync(filePath, 'utf-8');
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) {
    console.warn('Could not load donations.json, starting empty:', e.message);
  }
  return [];
}

let donations = loadDonations();

function saveDonations() {
  try {
    ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(donations, null, 2));
  } catch (e) {
    console.error('Failed to save donations.json:', e);
  }
}

// 6-char receipt code (A-Z, 0-9), unique across persisted data
function generateReceiptCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (donations.some(d => String(d.receiptCode || '').toUpperCase() === code));
  return code;
}

function nextId() {
  const maxId = donations.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
  return maxId + 1;
}

// Backward-compatible: default approveNow = true (aapke old behavior ki tarah)
function addOrApproveDonation(donation, opts = {}) {
  const approveNow = opts.approveNow !== undefined ? !!opts.approveNow : true;

  // Normalize incoming
  const d = { ...donation };

  if (!d.id) d.id = nextId();
  if (!d.receiptCode) d.receiptCode = generateReceiptCode();

  if (approveNow) {
    d.approved = true;
    d.status = 'approved';
    d.approvedAt = d.approvedAt || new Date();
    if (opts.approvedBy) d.approvedBy = opts.approvedBy;
    if (opts.approvedById) d.approvedById = opts.approvedById;
    if (opts.approvedByRole) d.approvedByRole = opts.approvedByRole;
    if (opts.approvedSource) d.approvedSource = opts.approvedSource;
  } else {
    d.approved = false;
    d.status = 'pending';
  }

  d.createdAt = d.createdAt || new Date();
  d.updatedAt = new Date();

  // Upsert by id (fallback by receiptCode)
  let idx = donations.findIndex(x => String(x.id) === String(d.id));
  if (idx === -1 && d.receiptCode) {
    idx = donations.findIndex(x => String(x.receiptCode) === String(d.receiptCode));
  }

  if (idx !== -1) {
    donations[idx] = { ...donations[idx], ...d };
  } else {
    donations.push(d);
  }

  saveDonations();
  return d;
}

module.exports = {
  generateReceiptCode,
  addOrApproveDonation,
  donations,       // shared list (loaded from disk at startup)
  saveDonations,   // call this if you mutate donations elsewhere
};