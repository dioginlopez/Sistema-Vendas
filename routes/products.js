const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
function resolveWritableDbFile() {
  const requestedFile = String(process.env.DB_FILE || '').trim();
  const candidates = [
    requestedFile,
    path.join(__dirname, '../db.json'),
    path.join(process.cwd(), 'db.json'),
    '/tmp/toca-db.json',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      return candidate;
    } catch (error) {
      // Try next fallback when current path is not writable.
    }
  }

  throw new Error('Nenhum caminho gravavel encontrado para o arquivo do banco');
}

const file = resolveWritableDbFile();
const adapter = new JSONFile(file);
const db = new Low(adapter, { products: [] });

function getPgSslConfig() {
  if (!DATABASE_URL) {
    return false;
  }
  const forceDisableSsl = String(process.env.PGSSLMODE || '').toLowerCase() === 'disable';
  const localConn = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
  if (forceDisableSsl || localConn) {
    return false;
  }
  return { rejectUnauthorized: false };
}

let pgPool = null;
if (DATABASE_URL) {
  try {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: getPgSslConfig(),
    });
  } catch (error) {
    pgPool = null;
    console.error('DATABASE_URL invalida. Rotas de produto continuam com modo local:', error.message);
  }
}

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
  if (!pgPool) {
    return;
  }

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const current = await pgPool.query('SELECT state FROM app_state WHERE id = 1 LIMIT 1');
  const baseState = current.rows.length && current.rows[0].state && typeof current.rows[0].state === 'object'
    ? current.rows[0].state
    : { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };

  baseState.products = Array.isArray(products) ? products : [];

  await pgPool.query(
    `
      INSERT INTO app_state (id, state, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
    `,
    [JSON.stringify(baseState)],
  );
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
  await db.read();
  db.data ||= { products: [] };

  if (pgPool) {
    try {
      const remoteState = await pgPool.query('SELECT state FROM app_state WHERE id = 1 LIMIT 1');
      const state = remoteState.rows.length ? remoteState.rows[0].state : null;
      if (state && typeof state === 'object' && Array.isArray(state.products)) {
        db.data.products = state.products;
      }
    } catch (error) {
      console.error('Falha ao ler produtos no PostgreSQL:', error.message);
    }
  }

  db.data.products = Array.isArray(db.data.products)
    ? db.data.products
      .map((product) => normalizeProductPayload(product, product))
      .filter((product) => !product.error)
    : [];

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

module.exports = router;