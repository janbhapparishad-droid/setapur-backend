const router = require('express').Router();
const ctrl = require('../controllers/expenseController');

// IMPORTANT: import your authRole middleware from server or from a util;
// if it's in server.js only, move it to its own module (middleware/auth.js).
const { authRole } = require('../middleware/auth'); // adjust path

// New API
router.get('/list', authRole(['user','admin','mainadmin']), ctrl.list);
router.post('/submit', authRole(['user','admin','mainadmin']), ctrl.submit);
router.post('/', authRole(['admin','mainadmin']), ctrl.create);
router.put('/:id', authRole(['admin','mainadmin']), ctrl.update);
router.post('/:id/enable', authRole(['admin','mainadmin']), ctrl.enable);
router.post('/admin/:id/approve', authRole(['admin','mainadmin']), ctrl.approve);
router.delete('/:id', authRole(['admin','mainadmin']), ctrl.remove);

// Legacy (optional)
router.post('/create-legacy', authRole(['admin','mainadmin']), ctrl.createExpense);
router.get('/legacy-list', authRole(['user','admin','mainadmin']), ctrl.getExpenses);

module.exports = router;