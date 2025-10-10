const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, '../data/categories.json');

// Load categories from JSON file
function loadCategories() {
  try {
    const data = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Save categories to JSON file
function saveCategories(categories) {
  fs.writeFileSync(dataFile, JSON.stringify(categories, null, 2));
}

// Generate next ID
function getNextId(categories) {
  return categories.length ? Math.max(...categories.map(c => c.id)) + 1 : 1;
}

// Get all categories
router.get('/categories/list', (req, res) => {
  const categories = loadCategories();
  res.json(categories);
});

// Create new category
router.post('/admin/categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: "Name is required" });

  const categories = loadCategories();
  if (categories.find(c => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ message: "Category already exists" });
  }

  const newCategory = { id: getNextId(categories), name, isEnabled: true };
  categories.push(newCategory);
  saveCategories(categories);

  res.status(201).json(newCategory);
});

// Update category (name and isEnabled)
router.put('/admin/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, isEnabled } = req.body;

  const categories = loadCategories();
  const category = categories.find(c => c.id === id);
  if (!category) return res.status(404).json({ message: "Category not found" });

  if (name) category.name = name;
  if (typeof isEnabled === 'boolean') category.isEnabled = isEnabled;

  saveCategories(categories);
  res.json(category);
});

// Delete category by id
router.delete('/admin/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let categories = loadCategories();

  if (!categories.find(c => c.id === id)) {
    return res.status(404).json({ message: "Category not found" });
  }

  categories = categories.filter(c => c.id !== id);
  saveCategories(categories);
  res.json({ message: "Category deleted" });
});

module.exports = router;
