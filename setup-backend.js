const fs = require('fs');
const path = require('path');

const folders = ['gallery', 'pending_uploads', 'controllers', 'routes', 'middleware', 'models', 'uploads'];

// Create folders if not exist
folders.forEach(f => {
  const dir = path.join(__dirname, f);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    console.log(`Created folder: ${f}`);
  }
});

// Write authentication middleware stub
const authMiddleware = `
// middleware/authMiddleware.js
module.exports = {
  verifyUser: (req, res, next) => { /* Simple user auth stub */ next(); },
  verifyAdmin: (req, res, next) => { /* Simple admin auth stub */ next(); }
};
`;
fs.writeFileSync(path.join(__dirname, 'middleware', 'authMiddleware.js'), authMiddleware, 'utf8');
console.log('Authentication middleware created.');

// Write simple JSON DB helpers
const dbHelper = `
// models/jsonDb.js - simple JSON file db helper
const fs = require('fs');
const dbPath = './data.json';

function readDB() {
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ gallery: [], pending: [] }));
  return JSON.parse(fs.readFileSync(dbPath));
}
function writeDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}
module.exports = { readDB, writeDB };
`;
fs.writeFileSync(path.join(__dirname, 'models', 'jsonDb.js'), dbHelper, 'utf8');
console.log('JSON DB helper created.');

// Write galleryController.js with full logic
const galleryController = `
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
`;
fs.writeFileSync(path.join(__dirname, 'controllers', 'galleryController.js'), galleryController, 'utf8');
console.log('Gallery controller created.');

// Write galleryRoutes.js with full routes
const galleryRoutes = `
// routes/galleryRoutes.js
const express = require('express');
const router = express.Router();
const galleryController = require('../controllers/galleryController');
const authMiddleware = require('../middleware/authMiddleware');

// User upload request
router.post('/request-upload', authMiddleware.verifyUser, galleryController.requestUpload);

// Admin direct upload
router.post('/upload', authMiddleware.verifyAdmin, galleryController.uploadPhoto);

// Admin get pending upload requests
router.get('/pending-uploads', authMiddleware.verifyAdmin, galleryController.listPending);

// Admin approve/reject upload
router.post('/approve-upload', authMiddleware.verifyAdmin, galleryController.approveUpload);

// Get gallery photos
router.get('/gallery', authMiddleware.verifyUser, galleryController.getGallery);

module.exports = router;
`;
fs.writeFileSync(path.join(__dirname, 'routes', 'galleryRoutes.js'), galleryRoutes, 'utf8');
console.log('Gallery routes created.');

// Update or create main server file (server.js)
const serverFile = path.join(__dirname, 'server.js');
let serverContent = '';
if (fs.existsSync(serverFile)) {
  serverContent = fs.readFileSync(serverFile, 'utf8');
  if (!serverContent.includes('galleryRoutes')) {
    serverContent += `

// Added by setup-backend.js: gallery routes
const galleryRoutes = require('./routes/galleryRoutes');
app.use('/api/gallery', galleryRoutes);
`;
    fs.writeFileSync(serverFile, serverContent, 'utf8');
    console.log('Updated existing server.js with gallery routes.');
  } else {
    console.log('galleryRoutes already included in server.js');
  }
} else {
  serverContent = `
// server.js - Basic setup with express and gallery routes

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Auth middleware stubs
const authMiddleware = require('./middleware/authMiddleware');

// Gallery routes
const galleryRoutes = require('./routes/galleryRoutes');
app.use('/api/gallery', galleryRoutes);

app.listen(port, () => {
  console.log('Server running on port ' + port);
});
`;
  fs.writeFileSync(serverFile, serverContent, 'utf8');
  console.log('Created new server.js with gallery routes.');
}

console.log('\nSetup complete! Run "npm install express" if not installed, then "node server.js" to start backend.');
