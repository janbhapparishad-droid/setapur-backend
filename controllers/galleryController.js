
// controllers/galleryController.js
const fs = require('fs');
const path = require('path');
const { readDB, writeDB } = require('../models/jsonDb');

// Main folders
const galleryDir = path.join(__dirname, '..', 'gallery');
const pendingDir = path.join(__dirname, '..', 'pending_uploads');

exports.requestUpload = (req, res) => {
  // Expect multipart form upload with 'photo' in req.files (implement multer in real project)
  // Here we just simulate request

  const { filename, uploader } = req.body; // Simulated data
  if (!filename || !uploader) return res.status(400).send('Missing filename or uploader');

  // Simulate saving file to pending uploads folder
  // For demo, just store metadata

  const db = readDB();
  db.pending.push({ id: Date.now(), filename, uploader, status: 'pending', date: new Date().toISOString() });
  writeDB(db);

  res.send({ message: 'Upload request received for approval.' });
};

exports.uploadPhoto = (req, res) => {
  // Admin direct upload simulation
  const { filename } = req.body;
  if (!filename) return res.status(400).send('Missing filename');

  // Add to gallery directly
  const db = readDB();
  db.gallery.push({ id: Date.now(), filename, date: new Date().toISOString() });
  writeDB(db);

  res.send({ message: 'Photo uploaded to gallery by admin.' });
};

exports.listPending = (req, res) => {
  const db = readDB();
  res.send(db.pending.filter(p => p.status === 'pending'));
};

exports.approveUpload = (req, res) => {
  const { id, approve } = req.body;
  if (!id || typeof approve === 'undefined') return res.status(400).send('Missing id or approve');

  const db = readDB();
  const index = db.pending.findIndex(p => p.id == id);
  if (index === -1) return res.status(404).send('Request not found');

  if (approve) {
    // Move to gallery
    const item = db.pending.splice(index, 1)[0];
    db.gallery.push({ id: Date.now(), filename: item.filename, date: new Date().toISOString() });
    writeDB(db);
    res.send({ message: 'Upload approved and added to gallery.' });
  } else {
    // Reject: remove from pending only
    db.pending.splice(index, 1);
    writeDB(db);
    res.send({ message: 'Upload request rejected.' });
  }
};

exports.getGallery = (req, res) => {
  const db = readDB();
  res.send(db.gallery);
};
