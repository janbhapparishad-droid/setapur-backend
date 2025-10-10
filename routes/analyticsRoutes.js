// routes/analyticsRoutes.js
const express = require('express');
const router = express.Router();

const { donations } = require('../controllers/receiptController');

const isApproved = (d) =>
  d && (d.approved === true || d.approved === 'true' || d.approved === 1 || d.approved === '1');

const normalize = (s) =>
  String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function eventNameOf(ev) {
  if (!ev) return '';
  if (typeof ev === 'string') return ev;
  return (ev.name || ev.eventName || ev.title || ev.label || '').toString();
}

function eventConfigOf(ev) {
  // defaults: enabled true, show both buttons true
  if (!ev || typeof ev === 'string') {
    return { enabled: true, showDonationDetail: true, showExpenseDetail: true };
  }
  return {
    enabled: ev.enabled !== false,
    showDonationDetail: ev.showDonationDetail !== false,
    showExpenseDetail: ev.showExpenseDetail !== false,
  };
}

router.get('/summary', (req, res) => {
  try {
    const folders = req.app.locals.folders || [];
    const expenses = req.app.locals.expenses || [];

    // Build index only for enabled events
    const eventIndex = new Map();
    folders.forEach((folder, fIdx) => {
      const evs = Array.isArray(folder.events) ? folder.events : [];
      evs.forEach((ev) => {
        const evName = eventNameOf(ev);
        const cfg = eventConfigOf(ev);
        if (!cfg.enabled) return;
        const key = normalize(evName);
        if (key) eventIndex.set(key, { fIdx, evName, cfg });
      });
    });

    // Build summary skeleton with string event keys and config
    const summary = folders.map((folder) => {
      const eventsSummary = {};
      const evs = Array.isArray(folder.events) ? folder.events : [];
      evs.forEach((ev) => {
        const evName = eventNameOf(ev);
        const cfg = eventConfigOf(ev);
        if (!cfg.enabled) return; // hide disabled events from user app
        if (evName) {
          eventsSummary[evName] = {
            donationTotal: 0,
            expenseTotal: 0,
            donations: [],
            config: cfg,
          };
        }
      });
      return { folderName: folder.name, events: eventsSummary };
    });

    // Fill donations
    (donations || []).filter(isApproved).forEach((d) => {
      const hit = eventIndex.get(normalize(d.category));
      if (!hit) return;
      const bucket = summary[hit.fIdx].events[hit.evName];
      if (!bucket) return;
      bucket.donationTotal += Number(d.amount || 0);
      bucket.donations.push({
        donorName: d.donorName,
        amount: Number(d.amount || 0),
        paymentMethod: d.paymentMethod,
        code: d.code,
        receiptCode: d.receiptCode,
      });
    });

    // Fill expenses
    (expenses || []).forEach((e) => {
      const hit = eventIndex.get(normalize(e.category));
      if (!hit) return;
      const bucket = summary[hit.fIdx].events[hit.evName];
      if (!bucket) return;
      bucket.expenseTotal += Number(e.amount || 0);
    });

    if (String(req.query.debug || '').toLowerCase() === 'true') {
      return res.json({ summary, routeVersion: 'v3-config' });
    }

    return res.json(summary);
  } catch (error) {
    console.error('analytics summary error:', error);
    res.status(500).send('Summary failed');
  }
});

module.exports = router;