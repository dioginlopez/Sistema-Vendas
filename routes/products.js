const express = require('express');
const crypto = require('crypto');

// db, pgPool e persistDb são injetados pelo server.js via createProductsRouter({ db, pgPool, persistDb })
module.exports = function createProductsRouter({ db, pgPool, persistDb }) {
const router = express.Router();

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeOptionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function normalizeProductPayload(body, currentProduct) {
  const source = body && typeof body === 'object' ? body : {};
  const nome = String(source.nome ?? source.name ?? '').trim();
  const preco = normalizePositiveNumber(source.preco ?? source.price);
  const estoque = normalizeNonNegativeInteger(source.estoque ?? source.stock);

  if (!nome || preco === null || estoque === null) {
    return { error: 'Produto inválido: informe nome, preco e estoque válidos' };
  }

  return {
    id: currentProduct ? currentProduct.id : (source.id ?? crypto.randomUUID()),
    nome,
    preco,
    estoque,
    codigoBarras: normalizeOptionalText(source.codigoBarras),
    categoria: normalizeOptionalText(source.categoria),
    marca: normalizeOptionalText(source.marca),
    imagemUrl: normalizeOptionalText(source.imagemUrl),
  };
}

async function syncProductsToPg(products) {
  // Delegado ao persistDb compartilhado do server.js — não duplica a lógica de PG aqui.
  await persistDb();
}

function requireAdmin(req, res, next) {
  const perfil = req.session && req.session.user ? req.session.user.perfil : null;
  if (perfil === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Acesso permitido apenas para administrador' });
}

function requireCsrf(req, res, next) {
  const sessionToken = String(req.session && req.session.csrfToken ? req.session.csrfToken : '').trim();
  const requestToken = String(req.get('x-csrf-token') || req.query.csrfToken || '').trim();
  if (sessionToken && requestToken && sessionToken === requestToken) {
    return next();
  }

  return res.status(403).json({ error: 'Falha de validacao da sessao. Atualize a pagina e tente novamente.' });
}

// middleware to ensure db loaded
router.use(async (req, res, next) => {
  try {
    await db.read();
    db.data ||= { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
    db.data.products = Array.isArray(db.data.products)
      ? db.data.products
        .map((product) => normalizeProductPayload(product, product))
        .filter((product) => !product.error)
      : [];
    next();
  } catch (error) {
    console.error('Erro ao carregar db no router products:', error.message);
    next();
  }
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
router.post('/', requireAdmin, requireCsrf, async (req, res) => {
  const newProd = normalizeProductPayload(req.body || null, null);
  if (newProd.error) {
    return res.status(400).json({ error: newProd.error });
  }
  db.data.products.push(newProd);
  await db.write();
  await syncProductsToPg(db.data.products);
  res.status(201).json(newProd);
});

// update product
router.put('/:id', requireAdmin, requireCsrf, async (req, res) => {
  const prod = db.data.products.find(p => p.id === req.params.id);
  if (!prod) return res.status(404).json({ error: 'Product not found' });
  const normalized = normalizeProductPayload(req.body || null, prod);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  Object.keys(prod).forEach((key) => {
    delete prod[key];
  });
  Object.assign(prod, normalized);
  await db.write();
  await syncProductsToPg(db.data.products);
  res.json(prod);
});

// delete product
router.delete('/:id', requireAdmin, requireCsrf, async (req, res) => {
  const index = db.data.products.findIndex(p => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Product not found' });
  db.data.products.splice(index, 1);
  await db.write();
  await syncProductsToPg(db.data.products);
  res.status(204).end();
});

return router;
}; // fecha createProductsRouter