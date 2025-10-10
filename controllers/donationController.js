// controllers/donationController.js
// In-memory store for now. Replace with DB as needed.
const donations = []; // [{ donorName, amount, ... }]

exports.submitDonation = async (req, res) => {
  try {
    const { amount, paymentMethod, category, cashReceiverName } = req.body;
    const donorName = req.user.username;
    const screenshotPath = req.file?.path || null;

    if (!amount || !paymentMethod || !category) {
      return res.status(400).json({ error: 'amount, paymentMethod, and category are required' });
    }

    const donation = {
      id: donations.length + 1,
      donorName,
      amount: Number(amount),
      paymentMethod,
      category,
      cashReceiverName: cashReceiverName || null,
      approved: false,
      createdAt: new Date(),
      screenshotPath,
      receiptCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
    };

    donations.push(donation);
    res.status(201).json({ message: 'Donation submitted', donation });
  } catch (err) {
    console.error('submitDonation error:', err);
    res.status(500).send('Failed to submit donation');
  }
};

// Optional: list current user's donations
exports.getUserDonations = (req, res) => {
  const mine = donations.filter(d => d.donorName === req.user.username);
  res.json(mine);
};

// Admin: get all
exports.getAllDonations = (req, res) => {
  res.json(donations);
};

// Admin: approve/disapprove
exports.approveDonation = (req, res) => {
  const { code, approve } = req.body; // approve: boolean
  const d = donations.find(x => x.receiptCode === code);
  if (!d) return res.status(404).send('Donation not found');
  d.approved = !!approve;
  d.approvedBy = req.user.username;
  d.approvedAt = new Date();
  res.json({ message: `Donation ${approve ? 'approved' : 'disapproved'} successfully` });
};