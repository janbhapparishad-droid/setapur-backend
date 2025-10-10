// controllers/expenseController.js
const {
  expenses,
  loadExpenses,
  saveExpenses,
  getAll,
  setAll,
  nextId,
  ensureShape,
} = require('../models/Expense');

// Optional notification hook (server can set this)
let notify = (username, notif) => {};
exports.setNotifier = (fn) => { if (typeof fn === 'function') notify = fn; };

const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const isApprovedEnabled = (e) => e && e.approved === true && e.enabled !== false;

// ========== NEW API ==========

// GET /api/expenses/list
exports.list = (req, res) => {
  try {
    const role = (req.user && req.user.role) || 'user';
    const isAdmin = role === 'admin' || role === 'mainadmin';

    const q = (req.query.category || req.query.eventName || req.query.eventId || '').toString().trim().toLowerCase();
    const statusQ = (req.query.status || (isAdmin ? 'all' : 'approved')).toString().toLowerCase();
    const includeDisabledQ = (req.query.includeDisabled || '').toString().toLowerCase();
    const includeDisabled = includeDisabledQ === '1' || includeDisabledQ === 'true';
    const includePendingMineQ = (req.query.includePendingMine || req.query.mine || '').toString().toLowerCase();
    const includePendingMine = includePendingMineQ === '1' || includePendingMineQ === 'true';

    loadExpenses();
    let list = getAll().slice();

    if (q) list = list.filter(e => eq(e.category, q));

    if (isAdmin) {
      if (statusQ === 'approved') list = list.filter(e => e.approved === true);
      else if (statusQ === 'pending') list = list.filter(e => e.approved !== true);
      if (!includeDisabled) list = list.filter(e => e.enabled !== false);
    } else {
      let approvedEnabled = list.filter(isApprovedEnabled);
      if (includePendingMine && req.user && req.user.username) {
        const mine = list.filter(e => e.submittedBy === req.user.username && e.approved !== true);
        const ids = new Set(approvedEnabled.map(x => x.id));
        for (const x of mine) if (!ids.has(x.id)) approvedEnabled.push(x);
      }
      list = approvedEnabled;
    }

    list.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const db = b.date ? new Date(b.date).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return db - da;
    });

    res.json(list);
  } catch (e) {
    console.error('list expenses error:', e);
    res.status(500).send('Failed to list expenses');
  }
};

// POST /api/expenses/submit (user)
exports.submit = (req, res) => {
  try {
    const { amount, category, eventName, description, paidTo, date } = req.body || {};
    const cat = (category || eventName || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category (event) is required' });
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });

    const now = new Date();
    const e = ensureShape({
      id: nextId(),
      amount: amt,
      category: cat,
      description: (description || '').toString().trim(),
      paidTo: (paidTo || '').toString().trim(),
      date: date ? new Date(date).toISOString() : now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      enabled: true,
      approved: false,
      status: 'pending',
      submittedBy: req.user?.username || null,
      submittedById: req.user?.id || null,
    });

    expenses.push(e);
    saveExpenses();

    if (e.submittedBy) {
      notify(e.submittedBy, {
        type: 'expenseSubmit',
        title: 'Expense submitted',
        body: `${e.category} • ₹${e.amount} (pending approval)`,
        data: { id: e.id, category: e.category, amount: e.amount, approved: false },
      });
    }

    res.status(201).json({ message: 'Expense submitted (pending)', expense: e });
  } catch (err) {
    console.error('submit expense error:', err);
    res.status(500).send('Submit expense failed');
  }
};

// POST /api/expenses (admin create; default approveNow=true)
exports.create = (req, res) => {
  try {
    const { amount, category, description, paidTo, date, approveNow } = req.body || {};
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
    const cat = (category || '').toString().trim();
    if (!cat) return res.status(400).json({ error: 'category is required' });

    const approve = approveNow !== false && approveNow !== 'false';
    const now = new Date();
    const e = ensureShape({
      id: nextId(),
      amount: amt,
      category: cat,
      description: (description || '').toString().trim(),
      paidTo: (paidTo || '').toString().trim(),
      date: date ? new Date(date).toISOString() : now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      enabled: true,
      approved: approve,
      status: approve ? 'approved' : 'pending',
      submittedBy: req.user?.username || null,
      submittedById: req.user?.id || null,
      approvedBy: approve ? (req.user?.username || null) : null,
      approvedById: approve ? (req.user?.id || null) : null,
      approvedAt: approve ? now.toISOString() : null,
    });

    expenses.push(e);
    saveExpenses();
    res.status(201).json({ message: 'Expense created', expense: e });
  } catch (err) {
    console.error('create expense error:', err);
    res.status(500).send('Create expense failed');
  }
};

// PUT /api/expenses/:id (admin)
exports.update = (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });

    const body = req.body || {};
    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });
      expenses[idx].amount = amt;
    }
    if (typeof body.category === 'string') expenses[idx].category = body.category.trim();
    if (typeof body.description === 'string') expenses[idx].description = body.description.trim();
    if (typeof body.paidTo === 'string') expenses[idx].paidTo = body.paidTo.trim();
    if (body.date) expenses[idx].date = new Date(body.date).toISOString();
    if (body.enabled !== undefined) expenses[idx].enabled = body.enabled !== false && body.enabled !== 'false';

    expenses[idx].updatedAt = new Date().toISOString();
    saveExpenses();
    res.json({ message: 'Expense updated', expense: expenses[idx] });
  } catch (err) {
    console.error('update expense error:', err);
    res.status(500).send('Update expense failed');
  }
};

// POST /api/expenses/:id/enable (admin)
exports.enable = (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
    const enabledRaw = req.body.enabled;
    const enabled = enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== 0 && enabledRaw !== '0';
    expenses[idx].enabled = enabled;
    expenses[idx].updatedAt = new Date().toISOString();
    saveExpenses();
    res.json({ ok: true, expense: expenses[idx] });
  } catch (e) {
    console.error('enable expense error:', e);
    res.status(500).send('Failed to enable/disable expense');
  }
};

// POST /admin/expenses/:id/approve (admin)
exports.approve = (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });

    const approveRaw = req.body.approve;
    const approve = approveRaw === true || approveRaw === 'true' || approveRaw === 1 || approveRaw === '1';

    expenses[idx].approved = approve;
    expenses[idx].status = approve ? 'approved' : 'pending';
    expenses[idx].approvedBy = req.user?.username || null;
    expenses[idx].approvedById = req.user?.id || null;
    expenses[idx].approvedAt = new Date().toISOString();
    expenses[idx].updatedAt = new Date().toISOString();

    if (expenses[idx].submittedBy) {
      notify(expenses[idx].submittedBy, {
        type: `expense${approve ? 'Approval' : 'Pending'}`,
        title: `Expense ${approve ? 'approved' : 'set to pending'}`,
        body: `${expenses[idx].category} • ₹${expenses[idx].amount}`,
        data: { id: expenses[idx].id, category: expenses[idx].category, approved: approve },
      });
    }

    saveExpenses();
    res.json({ message: `Expense ${approve ? 'approved' : 'set to pending'}`, expense: expenses[idx] });
  } catch (e) {
    console.error('approve expense error:', e);
    res.status(500).send('Approval failed');
  }
};

// DELETE /api/expenses/:id (admin)
exports.remove = (req, res) => {
  try {
    const { id } = req.params;
    const idx = expenses.findIndex(x => String(x.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
    const removed = expenses.splice(idx, 1)[0];
    saveExpenses();
    res.json({ message: 'Expense deleted', expense: removed });
  } catch (err) {
    console.error('delete expense error:', err);
    res.status(500).send('Delete expense failed');
  }
};

// ========== Backward-compatible endpoints (optional) ==========

// POST /expenses/create (legacy)
exports.createExpense = (req, res) => {
  const { reason, amount, category } = (req.body || {});
  if (!reason || amount === undefined || !category) return res.status(400).send('Missing fields');

  const e = ensureShape({
    id: nextId(),
    amount: Number(amount),
    category: String(category).trim(),
    description: String(reason).trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabled: true,
    approved: false,
    status: 'pending',
    submittedBy: req.user?.username || null,
    submittedById: req.user?.id || null,
  });

  expenses.push(e);
  saveExpenses();
  res.send('Expense created');
};

// GET /expenses/list (legacy)
exports.getExpenses = (req, res) => {
  loadExpenses();
  res.json(getAll());
};