// routes/analyticsAdminRoutes.js
const express = require('express');
const router = express.Router();
const { readFolders, writeFolders } = require('../models/analyticsStore');
const { randomUUID } = require('crypto');

function setFolders(app, folders) {
  app.locals.folders = folders;
  writeFolders(folders);
}

router.get('/folders', (req, res) => {
  const disk = readFolders();
  const folders = disk.length ? disk : (req.app.locals.folders || []);
  setFolders(req.app, folders);
  res.json(folders);
});

router.post('/folders', (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });
  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const folder = { id: randomUUID(), name: String(name).trim(), events: [] };
  folders.push(folder);
  setFolders(req.app, folders);
  res.status(201).json(folder);
});

router.put('/folders/:folderId', (req, res) => {
  const { name } = req.body || {};
  const { folderId } = req.params;
  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const idx = folders.findIndex(f => f.id === folderId);
  if (idx === -1) return res.status(404).json({ error: 'Folder not found' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });
  folders[idx].name = String(name).trim();
  setFolders(req.app, folders);
  res.json(folders[idx]);
});

router.delete('/folders/:folderId', (req, res) => {
  const { folderId } = req.params;
  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const idx = folders.findIndex(f => f.id === folderId);
  if (idx === -1) return res.status(404).json({ error: 'Folder not found' });
  const removed = folders.splice(idx, 1)[0];
  setFolders(req.app, folders);
  res.json({ message: 'Folder deleted', folder: removed });
});

router.post('/folders/:folderId/events', (req, res) => {
  const { name } = req.body || {};
  const { folderId } = req.params;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Event name is required' });

  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const f = folders.find(ff => ff.id === folderId);
  if (!f) return res.status(404).json({ error: 'Folder not found' });

  const event = {
    id: randomUUID(),
    name: String(name).trim(),
    enabled: true,
    showDonationDetail: true,
    showExpenseDetail: true,
  };
  f.events = Array.isArray(f.events) ? f.events : [];
  f.events.push(event);
  setFolders(req.app, folders);
  res.status(201).json(event);
});

router.put('/folders/:folderId/events/:eventId', (req, res) => {
  const { name } = req.body || {};
  const { folderId, eventId } = req.params;
  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const f = folders.find(ff => ff.id === folderId);
  if (!f) return res.status(404).json({ error: 'Folder not found' });
  const e = (f.events || []).find(ev => (ev.id || '').toString() === eventId);
  if (!e) return res.status(404).json({ error: 'Event not found' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Event name is required' });
  e.name = String(name).trim();
  setFolders(req.app, folders);
  res.json(e);
});

// NEW: update event config (enable/disable + detail visibility)
router.put('/folders/:folderId/events/:eventId/config', (req, res) => {
  const { folderId, eventId } = req.params;
  const { enabled, showDonationDetail, showExpenseDetail } = req.body || {};

  const toBool = (v) => (typeof v === 'boolean' ? v : ['true', '1', 'on', 'yes'].includes(String(v).toLowerCase()));

  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const f = folders.find(ff => ff.id === folderId);
  if (!f) return res.status(404).json({ error: 'Folder not found' });

  const e = (f.events || []).find(ev => (ev.id || '').toString() === eventId);
  if (!e) return res.status(404).json({ error: 'Event not found' });

  if (enabled !== undefined) e.enabled = toBool(enabled);
  if (showDonationDetail !== undefined) e.showDonationDetail = toBool(showDonationDetail);
  if (showExpenseDetail !== undefined) e.showExpenseDetail = toBool(showExpenseDetail);

  setFolders(req.app, folders);
  res.json({ message: 'Config updated', event: e });
});

router.delete('/folders/:folderId/events/:eventId', (req, res) => {
  const { folderId, eventId } = req.params;
  const folders = readFolders().length ? readFolders() : (req.app.locals.folders || []);
  const f = folders.find(ff => ff.id === folderId);
  if (!f) return res.status(404).json({ error: 'Folder not found' });
  f.events = Array.isArray(f.events) ? f.events : [];
  const idx = f.events.findIndex(ev => (ev.id || '').toString() === eventId);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  const removed = f.events.splice(idx, 1)[0];
  setFolders(req.app, folders);
  res.json({ message: 'Event deleted', event: removed });
});

module.exports = router;