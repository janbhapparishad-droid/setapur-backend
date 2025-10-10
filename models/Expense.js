// models/Expense.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const filePath = path.join(dataDir, 'expenses.json');

// In-memory list (single source of truth in this process)
let expenses = [];

function ensureShape(e) {
  const nowIso = new Date().toISOString();
  return {
    id: Number(e.id) || 0,
    amount: Number(e.amount) || 0,
    category: (e.category || '').toString().trim(),
    description: (e.description || e.reason || '').toString().trim(),
    paidTo: (e.paidTo || '').toString().trim(),
    date: e.date ? new Date(e.date).toISOString() : (e.date === null ? null : undefined),
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : nowIso,
    updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : nowIso,
    enabled: e.enabled === false ? false : true,
    approved: e.approved === true,
    status: e.status === 'pending' || e.approved !== true ? 'pending' : 'approved',
    submittedBy: e.submittedBy || null,
    submittedById: e.submittedById || null,
    approvedBy: e.approvedBy || null,
    approvedById: e.approvedById || null,
    approvedAt: e.approvedAt ? new Date(e.approvedAt).toISOString() : null,
  };
}

function loadExpenses() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expenses = Array.isArray(parsed) ? parsed.map(ensureShape) : [];
    } else {
      expenses = [];
    }
  } catch (e) {
    console.warn('Expense load failed:', e.message);
    expenses = [];
  }
  return expenses;
}

function saveExpenses() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(expenses, null, 2));
  } catch (e) {
    console.error('Expense save failed:', e.message);
  }
}

function getAll() { return expenses; }

function setAll(arr) {
  expenses = (arr || []).map(ensureShape);
  saveExpenses();
  return expenses;
}

function nextId() {
  return (expenses.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1);
}

// Load immediately on first require
loadExpenses();

module.exports = {
  expenses,         // reference to live array
  loadExpenses,
  saveExpenses,
  getAll,
  setAll,
  nextId,
  ensureShape,
  filePath,
  dataDir,
};