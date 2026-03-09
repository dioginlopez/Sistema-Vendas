const express = require('express');
const router = express.Router();
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');
const { nanoid } = require('nanoid');

const file = path.join(__dirname, '../db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter, { products: [] });

function requireAdmin(req, res, next) {
  const perfil = req.session && req.session.user ? req.session.user.perfil : null;
  if (perfil === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Acesso permitido apenas para administrador' });
}

// middleware to ensure db loaded
router.use(async (req, res, next) => {
  await db.read();
  db.data ||= { products: [] };
  next();
});

// list all products
router.get('/', (req, res) => {
  res.json(db.data.products);
});

// get one product
router.get('/:id', (req, res) => {
  const prod = db.data.products.find(p => p.id === req.params.id);
  if (!prod) return res.status(404).json({ error: 'Product not found' });
  res.json(prod);
});

// create product
router.post('/', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body;
  const newProd = { id: nanoid(), name, price: parseFloat(price), stock: parseInt(stock, 10) };
  db.data.products.push(newProd);
  await db.write();
  res.status(201).json(newProd);
});

// update product
router.put('/:id', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body;
  const prod = db.data.products.find(p => p.id === req.params.id);
  if (!prod) return res.status(404).json({ error: 'Product not found' });
  prod.name = name;
  prod.price = parseFloat(price);
  prod.stock = parseInt(stock, 10);
  await db.write();
  res.json(prod);
});

// delete product
router.delete('/:id', requireAdmin, async (req, res) => {
  const index = db.data.products.findIndex(p => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Product not found' });
  db.data.products.splice(index, 1);
  await db.write();
  res.status(204).end();
});

module.exports = router;