const express = require('express');
const router = express.Router();

// Use the same donations source your submit/approve uses:
const { donations } = require('../controllers/receiptController');

const isApproved = (d) =>
  d && (d.approved === true || d.approved === 'true' || d.approved === 1 || d.approved === '1');

const toNumber = (v) => Number(v || 0);

// GET /totals
router.get('/', (req, res) => {
  try {
    const expenses = req.app.locals?.expenses || [];
    const approvedDonations = (donations || []).filter(isApproved);
    const totalDonation = approvedDonations.reduce((sum, d) => sum + toNumber(d.amount), 0);
    const totalExpense = (Array.isArray(expenses) ? expenses : []).reduce(
      (sum, e) => sum + toNumber(e.amount),
      0
    );
    const balance = totalDonation - totalExpense;
    return res.json({ totalDonation, totalExpense, balance });
  } catch (e) {
    console.error('Totals route error:', e);
    return res.status(500).send('Totals failed');
  }
});

// Optional: quick debug
router.get('/debug', (req, res) => {
  try {
    const approved = (donations || []).filter(isApproved);
    const pending = (donations || []).filter((d) => !isApproved(d));
    return res.json({
      allCount: (donations || []).length,
      approvedCount: approved.length,
      pendingCount: pending.length,
      approvedSample: approved.slice(0, 5).map((d) => ({
        code: d.code, amount: d.amount, category: d.category
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: 'debug failed' });
  }
});

module.exports = router;