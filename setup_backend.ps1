# Folders to create
$folders = @("controllers", "models", "routes", "middleware", "utils", "uploads")

foreach ($folder in $folders) {
    if (-not (Test-Path $folder)) {
        New-Item -ItemType Directory -Name $folder
        Write-Host "Folder created: $folder"
    }
    else {
        Write-Host "Folder already exists: $folder"
    }
}

# Helper function to create a file with content
function Create-FileWithContent($path, $content) {
    $content | Out-File -FilePath $path -Encoding UTF8
    Write-Host "File created: $path"
}

# models/User.js
Create-FileWithContent "models\User.js" @"
const users = [];
module.exports = users;
"@

# models/Donation.js
Create-FileWithContent "models\Donation.js" @"
const donations = [];
module.exports = donations;
"@

# models/Expense.js
Create-FileWithContent "models\Expense.js" @"
const expenses = [];
module.exports = expenses;
"@

# utils/codeGenerator.js
Create-FileWithContent "utils\codeGenerator.js" @"
// Generate unique 6-digit alphanumeric code
function generateCode(existingCodes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (existingCodes.includes(code));
  return code;
}

module.exports = { generateCode };
"@

# middleware/authMiddleware.js
Create-FileWithContent "middleware\authMiddleware.js" @"
const jwt = require('jsonwebtoken');
const users = require('../models/User');
const SECRET_KEY = 'your_secret_key_here';

// Role based authentication middleware with ban user check
function authRole(role) {
  return (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).send('Access Denied');
    try {
      const verified = jwt.verify(token, SECRET_KEY);
      req.user = verified;

      const currentUser = users.find(u => u.username === req.user.username);
      if (!currentUser || currentUser.banned) return res.status(403).send('User banned or does not exist');

      if (role !== 'any' && req.user.role !== role) {
        return res.status(403).send('Forbidden');
      }

      next();
    } catch (err) {
      res.status(400).send('Invalid Token');
    }
  };
}

module.exports = { authRole };
"@

# controllers/authController.js
Create-FileWithContent "controllers\authController.js" @"
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../models/User');
const SECRET_KEY = 'your_secret_key_here';

exports.createUser = async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res.status(400).send('Missing fields');
  if (users.find(u => u.username === username))
    return res.status(400).send('User exists');

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  users.push({ id: users.length + 1, username, passwordHash, role, banned: false, loggedInDevice: null });
  res.send('User created successfully');
};

exports.login = async (req, res) => {
  const { username, password, deviceId } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).send('User not found');
  if (user.banned) return res.status(403).send('User banned');

  const validPass = await bcrypt.compare(password, user.passwordHash);
  if (!validPass) return res.status(400).send('Invalid password');

  // Single device login enforcement
  if (user.loggedInDevice && user.loggedInDevice !== deviceId) {
    user.loggedInDevice = deviceId; // Override existing session
  } else {
    user.loggedInDevice = deviceId;
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET_KEY,
    { expiresIn: '8h' }
  );
  res.json({ token });
};
"@

# controllers/donationController.js
Create-FileWithContent "controllers\donationController.js" @"
const donations = require('../models/Donation');
const { generateCode } = require('../utils/codeGenerator');
const fs = require('fs');

exports.submitDonation = (req, res) => {
  const { donorName, amount, paymentMethod, category, cashReceiverName } = req.body;
  const screenshotPath = req.file ? req.file.path : null;

  if (!donorName || !amount || !paymentMethod || !category)
    return res.status(400).send('Missing donation fields');

  const existingCodes = donations.map(d => d.code);
  const code = generateCode(existingCodes);

  donations.push({
    code,
    donorName,
    amount: parseFloat(amount),
    paymentMethod,
    screenshotPath,
    cashReceiverName,
    approved: false,
    approvedBy: null,
    category,
    submittedAt: new Date(),
  });

  res.json({ message: 'Donation submitted', code });
};

exports.approveDonation = (req, res) => {
  const { code, approve } = req.body;
  const donation = donations.find(d => d.code === code);
  if (!donation) return res.status(404).send('Donation not found');

  donation.approved = approve;
  donation.approvedBy = req.user.username;
  donation.approvedAt = new Date();

  if (approve) {
    if (donation.screenshotPath) {
      fs.unlink(donation.screenshotPath, err => {});
    }
    donation.screenshotPath = null;
    donation.cashReceiverName = null;
  }

  res.send(approve ? 'Donation approved' : 'Donation disapproved');
};

exports.getDonations = (req, res) => {
  if (req.user.role === 'user') {
    res.json(donations.filter(d => d.approved));
  } else {
    res.json(donations);
  }
};
"@

# controllers/expenseController.js
Create-FileWithContent "controllers\expenseController.js" @"
const expenses = require('../models/Expense');

exports.createExpense = (req, res) => {
  const { reason, amount, category } = req.body;
  if (!reason || !amount || !category) return res.status(400).send('Missing fields');
  const id = expenses.length + 1;
  expenses.push({ id, reason, amount: parseFloat(amount), category, createdAt: new Date() });
  res.send('Expense created');
};

exports.getExpenses = (req, res) => {
  res.json(expenses);
};
"@

# controllers/adminController.js
Create-FileWithContent "controllers\adminController.js" @"
const users = require('../models/User');

exports.getUsers = (req, res) => {
  res.json(users);
};

exports.banUser = (req, res) => {
  const { username, ban } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(404).send('User not found');
  user.banned = ban;
  if (ban) user.loggedInDevice = null;
  res.send(\`User \${ban ? 'banned' : 'unbanned'} successfully\`);
};
"@

# routes/authRoutes.js
Create-FileWithContent "routes\authRoutes.js" @"
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/create-user', authController.createUser);
router.post('/login', authController.login);

module.exports = router;
"@

# routes/donationRoutes.js
Create-FileWithContent "routes\donationRoutes.js" @"
const express = require('express');
const router = express.Router();
const donationController = require('../controllers/donationController');
const { authRole } = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const dir = path.join(__dirname, '../uploads', req.body.category || 'uncategorized');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

router.post('/submit-donation', authRole('user'), upload.single('screenshot'), donationController.submitDonation);
router.post('/approve-donation', authRole('admin'), donationController.approveDonation);
router.get('/donations', authRole('any'), donationController.getDonations);

module.exports = router;
"@

# routes/expenseRoutes.js
Create-FileWithContent "routes\expenseRoutes.js" @"
const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { authRole } = require('../middleware/authMiddleware');

router.post('/create-expense', authRole('admin'), expenseController.createExpense);
router.get('/expenses', authRole('admin'), expenseController.getExpenses);

module.exports = router;
"@

# routes/adminRoutes.js
Create-FileWithContent "routes\adminRoutes.js" @"
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authRole } = require('../middleware/authMiddleware');

router.get('/users', authRole('mainadmin'), adminController.getUsers);
router.post('/ban-user', authRole('mainadmin'), adminController.banUser);

module.exports = router;
"@

# server.js
Create-FileWithContent "server.js" @"
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const donationRoutes = require('./routes/donationRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/auth', authRoutes);
app.use('/donation', donationRoutes);
app.use('/expense', expenseRoutes);
app.use('/admin', adminRoutes);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(\`Server listening on port \${PORT}\`);
});
"@

Write-Host "Setup complete! You can now run 'npm install express bcryptjs jsonwebtoken cors body-parser multer' and then start your server with 'node server.js'."
