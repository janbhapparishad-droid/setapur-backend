// routes/donationRoutes.js
const express = require('express');
const router = express.Router();
const donationController = require('../controllers/donationController');
const { authRole } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

// Allow user/admin/mainadmin to submit (so your mainadmin token can test).
// Later, restrict to ['user'] if you want only users to submit.
router.post('/submit-donation',
  authRole(['user', 'admin', 'mainadmin']),
  upload.single('screenshot'),
  donationController.submitDonation
);

// User: my donations
router.get('/donations', authRole(['user', 'admin', 'mainadmin']), donationController.getUserDonations);

// Admin: all donations
router.get('/all-donations', authRole(['admin', 'mainadmin']), donationController.getAllDonations);

// Admin: approve
router.post('/approve', authRole(['mainadmin']), donationController.approveDonation);

module.exports = router;