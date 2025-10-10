
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
