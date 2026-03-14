const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const crypto = require('crypto');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const net = require('net');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 's3cr3t-local';
const isProduction = process.env.NODE_ENV === 'production';
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const APP_COMMIT = String(process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || '').trim() || 'local';
const APP_VERSION = String(process.env.npm_package_version || '1.0.0').trim();
const APP_BOOT_TIME = new Date().toISOString();
const AUTO_BACKUP_INTERVAL_MINUTES = Math.max(0, Number(process.env.AUTO_BACKUP_INTERVAL_MINUTES || 1440));
const AUTO_BACKUP_RETENTION = Math.max(1, Number(process.env.AUTO_BACKUP_RETENTION || 30));
const AUTO_BACKUP_ON_START = String(process.env.AUTO_BACKUP_ON_START || 'true').toLowerCase() !== 'false';
const STATE_PAYLOAD_LIMIT = String(process.env.STATE_PAYLOAD_LIMIT || '10mb').trim() || '10mb';
const PASSWORD_HASH_ROUNDS = Math.max(8, Number(process.env.PASSWORD_HASH_ROUNDS || 10));
const BOOTSTRAP_ADMIN_CPF = normalizeCpf(process.env.BOOTSTRAP_ADMIN_CPF || '');
const BOOTSTRAP_ADMIN_SENHA = String(process.env.BOOTSTRAP_ADMIN_SENHA || '');
const BOOTSTRAP_ADMIN_NOME = String(process.env.BOOTSTRAP_ADMIN_NOME || 'ADMIN').trim() || 'ADMIN';
const GOOGLE_CSE_API_KEY = String(process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const GOOGLE_CSE_CX = String(process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_ENGINE_ID || '').trim();

if (isProduction) {
  // Allow secure cookies behind reverse proxies (Railway/Render).
  app.set('trust proxy', 1);
}

function normalizeCpf(cpf) {
  return String(cpf || '').replace(/\D/g, '');
}

function normalizeGenericCode(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findProductByAnyCode(codigoInformado) {
  const codigoOriginal = String(codigoInformado || '').trim();
  if (!codigoOriginal) return null;

  const codigoNormalizado = normalizeGenericCode(codigoOriginal);
  const codigoDigitos = normalizeCpf(codigoOriginal);
  if (!codigoNormalizado && !codigoDigitos) return null;

  const produtos = Array.isArray(db.data && db.data.products) ? db.data.products : [];
  return produtos.find((produto) => {
    const candidatos = [produto && produto.codigoBarras, produto && produto.codigo, produto && produto.sku, produto && produto.id]
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    return candidatos.some((candidato) => {
      const normalizado = normalizeGenericCode(candidato);
      const digitos = normalizeCpf(candidato);
      if (codigoNormalizado && normalizado === codigoNormalizado) return true;
      if (codigoDigitos && digitos === codigoDigitos) return true;
      return false;
    });
  }) || null;
}

function isAdminUser(user) {
  return user && (user.perfil || 'operador') === 'admin' && user.ativo !== false;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasActiveAdminUser(users) {
  return Array.isArray(users) && users.some((user) => isAdminUser(user));
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

function isPasswordHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

async function hashPassword(password) {
  return bcrypt.hash(String(password || ''), PASSWORD_HASH_ROUNDS);
}

async function verifyUserPassword(user, password) {
  const senhaArmazenada = String(user && user.senha ? user.senha : '');
  const senhaInformada = String(password || '');
  if (!senhaArmazenada || !senhaInformada) {
    return { match: false, shouldUpgrade: false };
  }

  if (isPasswordHash(senhaArmazenada)) {
    return {
      match: await bcrypt.compare(senhaInformada, senhaArmazenada),
      shouldUpgrade: false,
    };
  }

  return {
    match: senhaArmazenada === senhaInformada,
    shouldUpgrade: senhaArmazenada === senhaInformada,
  };
}

async function ensureUserPasswordsHashed() {
  if (!Array.isArray(db.data.users) || db.data.users.length === 0) {
    return false;
  }

  let changed = false;
  for (const user of db.data.users) {
    if (!user || !user.senha || isPasswordHash(user.senha)) {
      continue;
    }

    user.senha = await hashPassword(user.senha);
    changed = true;
  }

  return changed;
}

function ensureSessionCsrfToken(req) {
  if (!req.session) {
    return '';
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }

  return req.session.csrfToken;
}

function extractRequestCsrfToken(req) {
  const headerToken = String(req.get('x-csrf-token') || '').trim();
  if (headerToken) {
    return headerToken;
  }

  const queryToken = String(req.query && req.query.csrfToken ? req.query.csrfToken : '').trim();
  if (queryToken) {
    return queryToken;
  }

  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const bodyToken = String(req.body.csrfToken || '').trim();
    if (bodyToken) {
      return bodyToken;
    }
  }

  return '';
}

function csrfTokensMatch(sessionToken, requestToken) {
  const sessionValue = String(sessionToken || '');
  const requestValue = String(requestToken || '');
  if (!sessionValue || !requestValue || sessionValue.length !== requestValue.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(sessionValue), Buffer.from(requestValue));
  } catch (error) {
    return false;
  }
}

function requireCsrf(req, res, next) {
  const sessionToken = ensureSessionCsrfToken(req);
  const requestToken = extractRequestCsrfToken(req);
  if (csrfTokensMatch(sessionToken, requestToken)) {
    return next();
  }

  const payload = { error: 'Falha de validacao da sessao. Atualize a pagina e tente novamente.' };
  if (req.path.startsWith('/api/') || String(req.get('accept') || '').includes('application/json') || req.get('x-requested-with') === 'fetch') {
    return res.status(403).json(payload);
  }
  return res.status(403).send(payload.error);
}

function normalizeStoredProduct(product, fallbackId) {
  if (!isPlainObject(product)) {
    return null;
  }

  const nome = String(product.nome ?? product.name ?? '').trim();
  const preco = normalizePositiveNumber(product.preco ?? product.price);
  const estoque = normalizeNonNegativeInteger(product.estoque ?? product.stock);
  if (!nome || preco === null || estoque === null) {
    return null;
  }

  const normalized = {
    id: product.id ?? fallbackId ?? crypto.randomUUID(),
    nome,
    preco,
    estoque,
  };

  const optionalFields = {
    codigoBarras: normalizeOptionalText(product.codigoBarras),
    codigo: normalizeOptionalText(product.codigo),
    sku: normalizeOptionalText(product.sku),
    marca: normalizeOptionalText(product.marca),
    imagemUrl: normalizeOptionalText(product.imagemUrl),
    categoria: normalizeOptionalText(product.categoria),
  };

  Object.entries(optionalFields).forEach(([key, value]) => {
    if (value !== undefined) {
      normalized[key] = value;
    }
  });

  const valorCasco = normalizePositiveNumber(product.valorCasco);
  if (valorCasco !== null) {
    normalized.valorCasco = valorCasco;
  }

  return normalized;
}

function cloneObjectArray(items) {
  if (!Array.isArray(items)) {
    return null;
  }

  const cloned = [];
  for (const item of items) {
    if (!isPlainObject(item)) {
      return null;
    }
    cloned.push({ ...item });
  }
  return cloned;
}

function sanitizeIncomingState(payload) {
  const { produtos, vendas, associados, vendaCounter, lastSaleId } = payload || {};
  if (!Array.isArray(produtos) || !Array.isArray(vendas) || !Array.isArray(associados)) {
    return { error: 'Estado inválido: produtos, vendas e associados devem ser listas' };
  }

  const produtosNormalizados = [];
  for (let index = 0; index < produtos.length; index += 1) {
    const produto = normalizeStoredProduct(produtos[index], `produto-${index + 1}`);
    if (!produto) {
      return { error: `Estado inválido: produto ${index + 1} está incompleto ou possui valores inválidos` };
    }
    produtosNormalizados.push(produto);
  }

  const vendasNormalizadas = cloneObjectArray(vendas);
  const associadosNormalizados = cloneObjectArray(associados);
  if (!vendasNormalizadas || !associadosNormalizados) {
    return { error: 'Estado inválido: vendas e associados devem conter apenas objetos válidos' };
  }

  const vendaCounterFinal = Number.isFinite(Number(vendaCounter)) && Number(vendaCounter) > 0
    ? Math.trunc(Number(vendaCounter))
    : 1;

  return {
    state: {
      products: produtosNormalizados,
      vendas: vendasNormalizadas,
      associados: associadosNormalizados,
      vendaCounter: vendaCounterFinal,
      lastSaleId: lastSaleId === null || lastSaleId === undefined || String(lastSaleId).trim() === ''
        ? null
        : String(lastSaleId),
    },
  };
}

function isBlockedIpAddress(hostname) {
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const [first, second] = hostname.split('.').map((part) => Number(part));
    return first === 10
      || first === 127
      || first === 0
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80');
  }

  return false;
}

function validateExternalImageUrl(urlParam) {
  const rawUrl = String(urlParam || '').trim();
  if (!rawUrl) {
    return { error: 'URL da imagem nao informada' };
  }

  let imageUrl;
  try {
    imageUrl = new URL(rawUrl);
  } catch (error) {
    return { error: 'URL da imagem invalida' };
  }

  if (!['http:', 'https:'].includes(imageUrl.protocol)) {
    return { error: 'Protocolo de URL nao permitido' };
  }

  const hostname = String(imageUrl.hostname || '').trim().toLowerCase();
  if (!hostname) {
    return { error: 'URL da imagem invalida' };
  }

  if (hostname === 'localhost' || hostname.endsWith('.local') || isBlockedIpAddress(hostname)) {
    return { error: 'Host de URL nao permitido' };
  }

  return { imageUrl };
}

function ensureDbShape() {
  db.data ||= { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
  db.data.products ||= [];
  db.data.users ||= [];
  db.data.vendas ||= [];
  db.data.associados ||= [];
  const vendaCounterAtual = Number(db.data.vendaCounter);
  db.data.vendaCounter = Number.isFinite(vendaCounterAtual) && vendaCounterAtual > 0 ? vendaCounterAtual : 1;
  db.data.lastSaleId = db.data.lastSaleId ?? null;
}

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
    console.error('DATABASE_URL inválida. Inicializando sem PostgreSQL:', error.message);
  }
}

async function ensurePgTable() {
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
}

async function loadStateFromPg() {
  if (!pgPool) {
    return null;
  }

  const result = await pgPool.query('SELECT state FROM app_state WHERE id = 1 LIMIT 1');
  if (!result.rows.length) {
    return null;
  }
  return result.rows[0].state || null;
}

async function saveStateToPg(state) {
  if (!pgPool) {
    return;
  }

  await pgPool.query(
    `
      INSERT INTO app_state (id, state, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
    `,
    [JSON.stringify(state || {})],
  );
}

let persistDbChain = Promise.resolve();

async function persistDbNow() {
  ensureDbShape();
  await db.write();
  if (!pgPool) {
    return;
  }

  try {
    await saveStateToPg(db.data);
  } catch (error) {
    console.error('Falha ao sincronizar estado no PostgreSQL:', error.message);
  }
}

function persistDb() {
  persistDbChain = persistDbChain
    .catch(() => {})
    .then(() => persistDbNow());
  return persistDbChain;
}

async function ensureBootstrapAdmin() {
  if (!Array.isArray(db.data.users) || hasActiveAdminUser(db.data.users)) {
    return false;
  }

  if (!BOOTSTRAP_ADMIN_CPF || !BOOTSTRAP_ADMIN_SENHA) {
    return false;
  }

  if (BOOTSTRAP_ADMIN_SENHA.length < 4) {
    console.warn('BOOTSTRAP_ADMIN_SENHA ignorada: senha deve ter pelo menos 4 caracteres.');
    return false;
  }

  const usuarioExistente = db.data.users.find((user) => normalizeCpf(user.cpf) === BOOTSTRAP_ADMIN_CPF);
  if (usuarioExistente) {
    usuarioExistente.nome = BOOTSTRAP_ADMIN_NOME;
    usuarioExistente.senha = await hashPassword(BOOTSTRAP_ADMIN_SENHA);
    usuarioExistente.perfil = 'admin';
    usuarioExistente.ativo = true;
    console.log(`Admin bootstrap reativado para o CPF ${BOOTSTRAP_ADMIN_CPF}.`);
    return true;
  }

  db.data.users.push({
    id: crypto.randomUUID(),
    nome: BOOTSTRAP_ADMIN_NOME,
    cpf: BOOTSTRAP_ADMIN_CPF,
    senha: await hashPassword(BOOTSTRAP_ADMIN_SENHA),
    perfil: 'admin',
    ativo: true,
    criadoEm: new Date().toISOString(),
  });

  console.log(`Admin bootstrap criado para o CPF ${BOOTSTRAP_ADMIN_CPF}.`);
  return true;
}

function resolveWritableDbFile() {
  const requestedFile = String(process.env.DB_FILE || '').trim();
  const candidates = [
    requestedFile,
    path.join(__dirname, 'db.json'),
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

// Setup LowDB
const file = resolveWritableDbFile();
const adapter = new JSONFile(file);
const db = new Low(adapter, { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null });
const backupDir = resolveWritableBackupDir();

function resolveWritableBackupDir() {
  const requestedDir = String(process.env.BACKUP_DIR || '').trim();
  const candidates = [
    requestedDir,
    path.join(path.dirname(file), 'backups'),
    path.join(__dirname, 'backups'),
    '/tmp/toca-backups',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch (error) {
      // Try next fallback when current path is not writable.
    }
  }

  throw new Error('Nenhum caminho gravavel encontrado para backups');
}

function formatBackupTimestamp(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function getStateSnapshot(reason) {
  return {
    createdAt: new Date().toISOString(),
    reason: String(reason || 'manual'),
    source: 'server-auto-backup',
    state: db.data || {},
  };
}

async function listBackupFiles() {
  const files = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const jsonFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);

  const details = await Promise.all(jsonFiles.map(async (name) => {
    const fullPath = path.join(backupDir, name);
    const stat = await fs.promises.stat(fullPath);
    return {
      name,
      fullPath,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      sortTime: stat.mtimeMs,
    };
  }));

  return details.sort((a, b) => b.sortTime - a.sortTime);
}

async function cleanupOldBackups() {
  const backups = await listBackupFiles();
  if (backups.length <= AUTO_BACKUP_RETENTION) {
    return;
  }

  const removals = backups.slice(AUTO_BACKUP_RETENTION);
  await Promise.all(removals.map(async (item) => {
    try {
      await fs.promises.unlink(item.fullPath);
    } catch (error) {
      console.error(`Falha ao remover backup antigo ${item.name}:`, error.message);
    }
  }));
}

async function createBackup(reason) {
  await ensureDbLoaded();
  const fileName = `backup-${formatBackupTimestamp()}-${String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const fullPath = path.join(backupDir, fileName);
  const snapshot = getStateSnapshot(reason);
  await fs.promises.writeFile(fullPath, JSON.stringify(snapshot, null, 2), 'utf8');
  await cleanupOldBackups();
  return { fileName, fullPath, createdAt: snapshot.createdAt };
}

let backupRunning = false;
async function runAutoBackupTick() {
  if (backupRunning) {
    return;
  }

  backupRunning = true;
  try {
    const backup = await createBackup('auto');
    console.log(`Backup automatico criado: ${backup.fileName}`);
  } catch (error) {
    console.error('Falha no backup automatico:', error.message);
  } finally {
    backupRunning = false;
  }
}

function startAutoBackupScheduler() {
  if (!AUTO_BACKUP_INTERVAL_MINUTES || AUTO_BACKUP_INTERVAL_MINUTES <= 0) {
    console.log('Backup automatico desativado (AUTO_BACKUP_INTERVAL_MINUTES <= 0).');
    return;
  }

  const intervalMs = AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000;
  if (AUTO_BACKUP_ON_START) {
    setTimeout(() => {
      runAutoBackupTick().catch(() => {});
    }, 20_000);
  }

  setInterval(() => {
    runAutoBackupTick().catch(() => {});
  }, intervalMs);

  console.log(`Backup automatico ativo a cada ${AUTO_BACKUP_INTERVAL_MINUTES} minuto(s).`);
}

async function initDB() {
  try {
    await ensurePgTable();
    await ensureDbLoaded();
  } catch (error) {
    console.error('Falha ao inicializar banco de dados:', error.message);
    db.data = { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
    ensureDbShape();
    await persistDb();
  }
}

initDB().catch((error) => {
  console.error('Erro crítico na inicialização do banco:', error.message);
});

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? 'auto' : false,
    // Session cookie: exige novo login ao fechar o navegador.
  },
}))

app.use(bodyParser.urlencoded({ extended: false, limit: STATE_PAYLOAD_LIMIT }));
app.use(bodyParser.json({ limit: STATE_PAYLOAD_LIMIT }));

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/api/version', (req, res) => {
  return res.json({
    version: APP_VERSION,
    commit: APP_COMMIT,
    bootTime: APP_BOOT_TIME,
    env: process.env.NODE_ENV || 'development',
  });
});

// auth middleware
async function requireLogin(req, res, next) {
  try {
    if (!(req.session && req.session.loggedIn)) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
      }
      return res.redirect('/login.html');
    }

    // Compatibilidade com sessões antigas (antes de salvar req.session.user no login).
    if (!req.session.user) {
      await ensureDbLoaded();
      const usuarioSessao = db.data.users.find((u) => isAdminUser(u)) || db.data.users.find((u) => u.ativo !== false);

      if (usuarioSessao) {
        req.session.user = {
          id: usuarioSessao.id,
          nome: usuarioSessao.nome,
          cpf: usuarioSessao.cpf,
          perfil: usuarioSessao.perfil || 'operador',
        };
      } else {
        req.session.loggedIn = false;
        if (req.path.startsWith('/api/')) {
          return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
        }
        return res.redirect('/login.html');
      }
    }

    return next();
  } catch (error) {
    console.error('Erro no middleware requireLogin:', error.message);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'Erro interno de autenticação' });
    }
    return res.redirect('/login.html');
  }
}

async function requireAdmin(req, res, next) {
  try {
    await ensureDbLoaded();

    const perfil = req.session && req.session.user ? req.session.user.perfil : null;
    if (!hasActiveAdminUser(db.data.users)) {
      return res.status(503).json({ error: 'Nenhum administrador ativo. Configure BOOTSTRAP_ADMIN_* para recuperar o acesso.' });
    }

    if (perfil === 'admin') {
      return next();
    }
    return res.status(403).json({ error: 'Acesso permitido apenas para administrador' });
  } catch (error) {
    console.error('Erro no middleware requireAdmin:', error.message);
    return res.status(500).json({ error: 'Erro interno de autorização' });
  }
}

async function ensureDbLoaded() {
  let shouldPersist = false;

  try {
    await db.read();
  } catch (error) {
    console.error('Falha ao ler db.json, recriando base:', error.message);
    db.data = { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
    ensureDbShape();
    shouldPersist = true;
  }

  if (pgPool) {
    try {
      const pgState = await loadStateFromPg();
      if (pgState && typeof pgState === 'object') {
        db.data = pgState;
        shouldPersist = true;
      }
    } catch (error) {
      console.error('Falha ao carregar estado do PostgreSQL:', error.message);
    }
  }

  const before = JSON.stringify(db.data || {});
  ensureDbShape();
  const bootstrapCriado = await ensureBootstrapAdmin();
  const senhasMigradas = await ensureUserPasswordsHashed();
  if (bootstrapCriado || senhasMigradas || before !== JSON.stringify(db.data || {}) || shouldPersist) {
    await persistDb();
  }
}

// login/logout routes
app.post('/login', async (req, res) => {
  try {
    const { cpf, senha } = req.body;
    const esperaJson = String(req.get('accept') || '').includes('application/json') || req.get('x-requested-with') === 'fetch';
    await ensureDbLoaded();

    const loginCpf = normalizeCpf(cpf);
    let user = db.data.users.find((item) => normalizeCpf(item.cpf) === loginCpf);

    // Modo recuperação para deploy: se o login usar BOOTSTRAP_ADMIN_*, garante/atualiza o admin e permite acesso.
    const credenciaisBootstrapInformadas = Boolean(BOOTSTRAP_ADMIN_CPF && BOOTSTRAP_ADMIN_SENHA);
    const loginEhBootstrap = credenciaisBootstrapInformadas
      && loginCpf === BOOTSTRAP_ADMIN_CPF
      && String(senha || '') === BOOTSTRAP_ADMIN_SENHA;

    if (loginEhBootstrap) {
      if (user) {
        user.nome = BOOTSTRAP_ADMIN_NOME;
        user.perfil = 'admin';
        user.ativo = true;
        user.senha = await hashPassword(BOOTSTRAP_ADMIN_SENHA);
      } else {
        user = {
          id: crypto.randomUUID(),
          nome: BOOTSTRAP_ADMIN_NOME,
          cpf: BOOTSTRAP_ADMIN_CPF,
          senha: await hashPassword(BOOTSTRAP_ADMIN_SENHA),
          perfil: 'admin',
          ativo: true,
          criadoEm: new Date().toISOString(),
        };
        db.data.users.push(user);
      }
      await persistDb();
    }

    const passwordCheck = user ? await verifyUserPassword(user, senha) : { match: false, shouldUpgrade: false };

    if (user && passwordCheck.match && user.ativo !== false) {
      if (passwordCheck.shouldUpgrade) {
        user.senha = await hashPassword(senha);
        await persistDb();
      }

      req.session.loggedIn = true;
      ensureSessionCsrfToken(req);
      req.session.user = {
        id: user.id,
        nome: user.nome,
        cpf: user.cpf,
        perfil: user.perfil || 'operador',
      };
      if (esperaJson) {
        return res.json({ ok: true, redirect: '/' });
      }
      return res.redirect('/');
    }

    if (esperaJson) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    return res.status(401).send('Credenciais inválidas');
  } catch (error) {
    console.error('Erro no login:', error.message);
    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(500).json({ error: 'Erro interno ao processar login. Tente novamente.' });
    }
    return res.status(500).send('Erro interno ao processar login. Tente novamente.');
  }
});

app.post('/logout', requireLogin, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login.html');
  });
});

app.post('/logout-beacon', requireLogin, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.status(204).end();
  });
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.session.user || null, csrfToken: ensureSessionCsrfToken(req) });
});

app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  await ensureDbLoaded();
  const users = db.data.users.map(({ senha, ...safeUser }) => safeUser);
  res.json(users);
});

app.get('/api/state', requireLogin, async (req, res) => {
  await ensureDbLoaded();
  return res.json({
    produtos: Array.isArray(db.data.products) ? db.data.products : [],
    vendas: Array.isArray(db.data.vendas) ? db.data.vendas : [],
    associados: Array.isArray(db.data.associados) ? db.data.associados : [],
    vendaCounter: Number.isFinite(Number(db.data.vendaCounter)) ? Number(db.data.vendaCounter) : 1,
    lastSaleId: db.data.lastSaleId ?? null,
  });
});

app.put('/api/state', requireLogin, requireCsrf, async (req, res) => {
  await ensureDbLoaded();

  const sanitized = sanitizeIncomingState(req.body || {});
  if (sanitized.error) {
    return res.status(400).json({ error: sanitized.error });
  }

  db.data.products = sanitized.state.products;
  db.data.vendas = sanitized.state.vendas;
  db.data.associados = sanitized.state.associados;
  db.data.vendaCounter = sanitized.state.vendaCounter;
  db.data.lastSaleId = sanitized.state.lastSaleId;

  await persistDb();
  return res.json({ ok: true });
});

app.post('/api/state/flush', requireLogin, requireCsrf, bodyParser.text({ type: '*/*', limit: STATE_PAYLOAD_LIMIT }), async (req, res) => {
  await ensureDbLoaded();

  let payload = req.body;
  if (typeof payload === 'string') {
    const texto = payload.trim();
    if (!texto) {
      return res.status(400).json({ error: 'Estado inválido: payload vazio' });
    }
    try {
      payload = JSON.parse(texto);
    } catch (error) {
      return res.status(400).json({ error: 'Estado inválido: payload nao e JSON valido' });
    }
  }

  const sanitized = sanitizeIncomingState(payload || {});
  if (sanitized.error) {
    return res.status(400).json({ error: sanitized.error });
  }

  db.data.products = sanitized.state.products;
  db.data.vendas = sanitized.state.vendas;
  db.data.associados = sanitized.state.associados;
  db.data.vendaCounter = sanitized.state.vendaCounter;
  db.data.lastSaleId = sanitized.state.lastSaleId;

  await persistDb();
  return res.json({ ok: true });
});

app.get('/api/backups', requireLogin, requireAdmin, async (req, res) => {
  try {
    const backups = await listBackupFiles();
    const items = backups.map(({ name, size, createdAt, modifiedAt }) => ({
      name,
      size,
      createdAt,
      modifiedAt,
    }));
    return res.json({ backups: items });
  } catch (error) {
    return res.status(500).json({ error: 'Falha ao listar backups' });
  }
});

app.post('/api/backups', requireLogin, requireAdmin, requireCsrf, async (req, res) => {
  try {
    const backup = await createBackup('manual');
    return res.status(201).json({
      ok: true,
      fileName: backup.fileName,
      createdAt: backup.createdAt,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Falha ao criar backup manual' });
  }
});

app.get('/api/backups/latest/download', requireLogin, requireAdmin, async (req, res) => {
  try {
    const backups = await listBackupFiles();
    const latest = backups[0];
    if (!latest) {
      return res.status(404).json({ error: 'Nenhum backup encontrado' });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${latest.name}"`);
    return res.sendFile(latest.fullPath);
  } catch (error) {
    return res.status(500).json({ error: 'Falha ao baixar backup mais recente' });
  }
});

app.get('/api/backups/:name/download', requireLogin, requireAdmin, async (req, res) => {
  const requestedName = path.basename(String(req.params.name || ''));
  if (!requestedName.endsWith('.json')) {
    return res.status(400).json({ error: 'Nome de backup invalido' });
  }

  const fullPath = path.join(backupDir, requestedName);
  if (!fullPath.startsWith(backupDir)) {
    return res.status(400).json({ error: 'Caminho de backup invalido' });
  }

  try {
    await fs.promises.access(fullPath, fs.constants.R_OK);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${requestedName}"`);
    return res.sendFile(fullPath);
  } catch (error) {
    return res.status(404).json({ error: 'Backup nao encontrado' });
  }
});

app.post('/api/users', requireLogin, requireAdmin, requireCsrf, async (req, res) => {
  await ensureDbLoaded();
  const { nome, cpf, senha, perfil, ativo } = req.body;

  const nomeLimpo = String(nome || '').trim();
  const cpfLimpo = String(cpf || '').trim();
  const senhaLimpa = String(senha || '');
  const perfilFinal = perfil === 'admin' ? 'admin' : 'operador';
  const cpfNormalizado = normalizeCpf(cpfLimpo);

  if (!nomeLimpo || !cpfNormalizado || !senhaLimpa) {
    return res.status(400).json({ error: 'Nome, CPF e senha são obrigatórios' });
  }

  if (senhaLimpa.length < 4) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
  }

  const cpfJaExiste = db.data.users.some((user) => normalizeCpf(user.cpf) === cpfNormalizado);
  if (cpfJaExiste) {
    return res.status(409).json({ error: 'Já existe usuário com este CPF' });
  }

  const novoUsuario = {
    id: crypto.randomUUID(),
    nome: nomeLimpo,
    cpf: cpfLimpo,
    senha: await hashPassword(senhaLimpa),
    perfil: perfilFinal,
    ativo: ativo !== false,
    criadoEm: new Date().toISOString(),
  };

  db.data.users.push(novoUsuario);
  await persistDb();

  const { senha: _, ...safeUser } = novoUsuario;
  return res.status(201).json(safeUser);
});

app.put('/api/users/:id', requireLogin, requireAdmin, requireCsrf, async (req, res) => {
  await ensureDbLoaded();
  const { id } = req.params;
  const user = db.data.users.find((item) => item.id === id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const { nome, cpf, senha, perfil, ativo } = req.body;
  const nomeLimpo = String(nome || '').trim();
  const cpfLimpo = String(cpf || '').trim();
  const cpfNormalizado = normalizeCpf(cpfLimpo);
  const perfilFinal = perfil === 'admin' ? 'admin' : 'operador';
  const ativoFinal = ativo !== false;

  if (!nomeLimpo || !cpfNormalizado) {
    return res.status(400).json({ error: 'Nome e CPF são obrigatórios' });
  }

  const cpfJaExiste = db.data.users.some((item) => item.id !== id && normalizeCpf(item.cpf) === cpfNormalizado);
  if (cpfJaExiste) {
    return res.status(409).json({ error: 'Já existe usuário com este CPF' });
  }

  const totalAdminsAtivos = db.data.users.filter((u) => isAdminUser(u)).length;
  const userEraAdminAtivo = isAdminUser(user);
  const userContinuaraAdminAtivo = perfilFinal === 'admin' && ativoFinal;

  if (userEraAdminAtivo && !userContinuaraAdminAtivo && totalAdminsAtivos <= 1) {
    return res.status(400).json({ error: 'Não é permitido remover ou desativar o último administrador' });
  }

  user.nome = nomeLimpo;
  user.cpf = cpfLimpo;
  user.perfil = perfilFinal;
  user.ativo = ativoFinal;

  if (typeof senha === 'string' && senha.length > 0) {
    if (senha.length < 4) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
    }
    user.senha = await hashPassword(senha);
  }

  await persistDb();
  const { senha: _, ...safeUser } = user;
  return res.json(safeUser);
});

app.delete('/api/users/:id', requireLogin, requireAdmin, requireCsrf, async (req, res) => {
  await ensureDbLoaded();
  const { id } = req.params;

  if (req.session.user && req.session.user.id === id) {
    return res.status(400).json({ error: 'Você não pode remover seu próprio usuário' });
  }

  const userAlvo = db.data.users.find((item) => item.id === id);
  if (!userAlvo) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const totalAdminsAtivos = db.data.users.filter((u) => isAdminUser(u)).length;
  if (isAdminUser(userAlvo) && totalAdminsAtivos <= 1) {
    return res.status(400).json({ error: 'Não é permitido remover o último administrador' });
  }

  const index = db.data.users.findIndex((item) => item.id === id);
  if (index === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

  db.data.users.splice(index, 1);
  await persistDb();
  return res.status(204).end();
});

app.get('/api/product-image', requireLogin, async (req, res) => {
  const nome = String(req.query.nome || '').trim();
  const codigoInformado = String(req.query.codigo || '').trim();
  const codigo = normalizeCpf(codigoInformado).trim();
  let nomeBusca = nome;
  let marcaBusca = '';

  await ensureDbLoaded();
  if (codigoInformado && !nomeBusca) {
    const produtoLocal = findProductByAnyCode(codigoInformado);
    if (produtoLocal) {
      nomeBusca = String(produtoLocal.nome || '').trim();
      marcaBusca = String(produtoLocal.marca || '').trim();
    }
  }

  if (!nomeBusca && !codigoInformado && !codigo) {
    return res.status(400).json({ error: 'Informe nome ou codigo do produto' });
  }

  let imageUrl = '';
  let source = '';
  const termoFallback = String(nomeBusca || codigoInformado || codigo || 'produto').trim();

  async function buscarImagemWikimedia(termo) {
    const consulta = String(termo || '').trim();
    if (!consulta) return '';

    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${consulta} produto embalagem`)}&gsrlimit=5&prop=imageinfo&iiprop=url|mime&format=json`;
    const resposta = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!resposta.ok) return '';

    const dados = await resposta.json();
    const pages = dados && dados.query && dados.query.pages ? Object.values(dados.query.pages) : [];
    if (!pages.length) return '';

    for (const page of pages) {
      const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
      const mime = String(info && info.mime ? info.mime : '').toLowerCase();
      if (info && info.url && mime.startsWith('image/')) {
        return String(info.url);
      }
    }

    return '';
  }

  if (codigo && codigo.length >= 8) {
    try {
      const resposta = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json`, {
        signal: AbortSignal.timeout(4500),
      });
      if (resposta.ok) {
        const dados = await resposta.json();
        if (dados && dados.status === 1 && dados.product) {
          const produto = dados.product;
          imageUrl = produto.image_front_url
            || produto.image_url
            || (produto.selected_images && produto.selected_images.front && produto.selected_images.front.display
              ? (produto.selected_images.front.display.pt || produto.selected_images.front.display.en || '')
              : '');
          source = imageUrl ? 'openfoodfacts' : '';
        }
      }
    } catch (error) {
      // Silent fallback to name-based image.
    }
  }

  if (!imageUrl && nomeBusca) {
    try {
      imageUrl = await buscarImagemWikimedia(`${nomeBusca} ${marcaBusca}`.trim());
      source = imageUrl ? 'wikimedia-name' : source;
    } catch (error) {
      // Silent fallback.
    }
  }

  if (!imageUrl && codigoInformado) {
    try {
      imageUrl = await buscarImagemWikimedia(codigoInformado);
      source = imageUrl ? 'wikimedia-barcode' : source;
    } catch (error) {
      // Silent fallback.
    }
  }

  function gerarSvgProdutoFallback(texto) {
    const base = String(texto || 'PRODUTO').toUpperCase().slice(0, 28);
    let hash = 0;
    for (const ch of base) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    const bg = `hsl(${hue} 62% 42%)`;
    const bg2 = `hsl(${(hue + 40) % 360} 65% 30%)`;
    const linhas = base.match(/.{1,14}/g) || ['PRODUTO'];

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${bg}" />
            <stop offset="100%" stop-color="${bg2}" />
          </linearGradient>
        </defs>
        <rect width="768" height="768" fill="url(#g)"/>
        <rect x="64" y="64" width="640" height="640" rx="38" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.24)"/>
        <text x="384" y="300" text-anchor="middle" font-size="110" font-family="Arial" fill="white">📦</text>
        <text x="384" y="430" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">${linhas[0] || ''}</text>
        <text x="384" y="490" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">${linhas[1] || ''}</text>
        <text x="384" y="560" text-anchor="middle" font-size="26" font-family="Arial" fill="rgba(255,255,255,0.9)">IMAGEM GERADA AUTOMATICAMENTE</text>
      </svg>
    `.trim();

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  if (!imageUrl) {
    imageUrl = gerarSvgProdutoFallback(termoFallback);
    source = 'local-fallback';
  }

  if (imageUrl.startsWith('data:image/')) {
    return res.json({ imageUrl, originalUrl: imageUrl, source });
  }

  const proxiedUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  return res.json({ imageUrl: proxiedUrl, originalUrl: imageUrl, source });
});

app.get('/api/product-image-options', requireLogin, async (req, res) => {
  const relatedParam = String(req.query.related || '').trim().toLowerCase();
  const semLimite = ['all', 'unlimited', 'sem-limite', 'sem_limite'].includes(relatedParam);
  const relatedRaw = Number.parseInt(relatedParam, 10);
  const relatedCount = semLimite
    ? null
    : (Number.isFinite(relatedRaw) ? Math.max(1, Math.min(120, relatedRaw)) : 9);
  const TOTAL_OPCOES_IMAGEM = semLimite ? null : (relatedCount + 1); // 1 principal + N relacionadas
  const nome = String(req.query.nome || '').trim();
  const codigoInformado = String(req.query.codigo || '').trim();
  const codigo = normalizeCpf(codigoInformado).trim();
  const marca = String(req.query.marca || '').trim();
  const sabor = String(req.query.sabor || '').trim();
  const categoria = String(req.query.categoria || '').trim();
  let nomeBusca = nome;
  let marcaBusca = marca;
  let saborBusca = sabor;
  let categoriaBusca = categoria;

  await ensureDbLoaded();
  if (codigoInformado && (!nomeBusca || !marcaBusca)) {
    const produtoLocal = findProductByAnyCode(codigoInformado);
    if (produtoLocal) {
      if (!nomeBusca) nomeBusca = String(produtoLocal.nome || '').trim();
      if (!marcaBusca) marcaBusca = String(produtoLocal.marca || '').trim();
      if (!saborBusca) saborBusca = String(produtoLocal.sabor || '').trim();
      if (!categoriaBusca) categoriaBusca = String(produtoLocal.categoria || '').trim();
    }
  }

  if (!nomeBusca && !codigoInformado && !codigo && !marcaBusca && !saborBusca && !categoriaBusca) {
    return res.status(400).json({ error: 'Informe nome, marca, sabor, categoria ou codigo do produto' });
  }

  const opcoes = [];
  const vistos = new Set();

  function gerarSvgProdutoFallback(texto) {
    const base = String(texto || 'PRODUTO').toUpperCase().slice(0, 28);
    let hash = 0;
    for (const ch of base) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    const bg = `hsl(${hue} 62% 42%)`;
    const bg2 = `hsl(${(hue + 40) % 360} 65% 30%)`;
    const linhas = base.match(/.{1,14}/g) || ['PRODUTO'];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg}" /><stop offset="100%" stop-color="${bg2}" /></linearGradient></defs>
        <rect width="768" height="768" fill="url(#g)"/>
        <rect x="64" y="64" width="640" height="640" rx="38" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.24)"/>
        <text x="384" y="300" text-anchor="middle" font-size="110" font-family="Arial" fill="white">📦</text>
        <text x="384" y="430" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">${linhas[0] || ''}</text>
        <text x="384" y="490" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">${linhas[1] || ''}</text>
      </svg>
    `.trim();
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function adicionarOpcao(url, source) {
    const limpa = String(url || '').trim();
    if (!limpa || vistos.has(limpa)) return;
    vistos.add(limpa);

    if (limpa.startsWith('data:image/')) {
      opcoes.push({ imageUrl: limpa, originalUrl: limpa, source });
      return;
    }

    opcoes.push({
      imageUrl: `/api/image-proxy?url=${encodeURIComponent(limpa)}`,
      originalUrl: limpa,
      source,
    });
  }

  function tokenizarTexto(valor) {
    return String(valor || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  const nomeTokens = tokenizarTexto(nomeBusca);
  const marcaTokens = tokenizarTexto(marcaBusca);
  const saborTokens = tokenizarTexto(saborBusca);
  const categoriaTokens = tokenizarTexto(categoriaBusca);
  const exigeNomeEMarca = nomeTokens.length > 0 && marcaTokens.length > 0;
  const exigeMarcaESabor = marcaTokens.length > 0 && saborTokens.length > 0;
  const codigoValido = codigo.length >= 8;
  const temContextoTexto = nomeTokens.length > 0 || marcaTokens.length > 0 || saborTokens.length > 0 || categoriaTokens.length > 0;
  const podeBuscarInternet = codigoValido || exigeNomeEMarca || exigeMarcaESabor || temContextoTexto;

  if (!codigoValido && !exigeNomeEMarca && !exigeMarcaESabor && !temContextoTexto) {
    return res.status(400).json({
      error: 'Para gerar imagem pela internet, informe codigo de barras valido ou dados do produto como nome, marca ou sabor.'
    });
  }

  function pontuarRelevancia(textoAlvo) {
    const texto = String(textoAlvo || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const contar = (tokens) => tokens.reduce((acc, token) => (texto.includes(token) ? acc + 1 : acc), 0);

    const nomeHits = contar(nomeTokens);
    const marcaHits = contar(marcaTokens);
    const saborHits = contar(saborTokens);
    const categoriaHits = contar(categoriaTokens);

    // Regra anti-aleatorio: se informou nome/marca, ao menos 1 token de cada deve aparecer.
    if (exigeNomeEMarca && nomeTokens.length > 0 && nomeHits === 0) return -1;
    if ((exigeNomeEMarca || exigeMarcaESabor) && marcaTokens.length > 0 && marcaHits === 0) return -1;

    // Modo estrito: quando nome e marca forem informados, ambos precisam bater no mesmo resultado.
    if (exigeNomeEMarca && (nomeHits === 0 || marcaHits === 0)) return -1;
    if (exigeMarcaESabor && (marcaHits === 0 || saborHits === 0)) return -1;

    let score = 0;
    score += nomeHits * 6;
    score += marcaHits * 8;
    score += saborHits * 9;
    score += categoriaHits * 4;

    if (codigo && texto.includes(codigo)) score += 10;
    return score;
  }

  async function buscarMelhoresImagensBing(termo, termoMarca, termoSabor, termoCategoria, limite = 12) {
    const consultaBase = [
      String(termo || '').trim(),
      String(termoMarca || '').trim(),
      String(termoSabor || '').trim(),
      String(termoCategoria || '').trim()
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!consultaBase) return [];

    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(`${consultaBase} produto embalagem marca`)}`;
    const resposta = await fetch(bingUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 TocaApp/1.0',
      },
    });

    if (!resposta.ok) return [];
    const html = await resposta.text();

    const resultados = [];
    const regexCards = /class="iusc"[^>]*\sm="([^"]+)"/gi;
    let match;
    while ((match = regexCards.exec(html)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      try {
        const decoded = raw
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');
        const payload = JSON.parse(decoded);
        const murl = String(payload && payload.murl ? payload.murl : '').trim();
        const titulo = String(payload && payload.t ? payload.t : '').toLowerCase();
        const descricao = String(payload && payload.desc ? payload.desc : '').toLowerCase();
        const texto = `${titulo} ${descricao}`;

        if (!murl) continue;

        const score = pontuarRelevancia(`${texto} ${murl}`);
        const scoreMinimo = exigeNomeEMarca ? 12 : 8;
        if (score < scoreMinimo) continue;

        resultados.push({ url: murl, score });
      } catch (error) {
        // ignore malformed card
      }
    }

    const ordenadas = resultados
      .sort((a, b) => b.score - a.score)
      .map((item) => item.url);

    if (limite === null) return ordenadas;
    return ordenadas.slice(0, Math.max(5, limite));
  }

  async function buscarMelhoresImagensGoogle(consultas, limite = 12) {
    const urls = [];
    const vistosGoogle = new Set();
    const consultasValidas = Array.from(new Set((Array.isArray(consultas) ? consultas : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)));

    for (const consulta of consultasValidas) {
      const googleUrl = `https://www.google.com/search?tbm=isch&hl=pt-BR&q=${encodeURIComponent(`${consulta} produto embalagem`)}`;
      const resposta = await fetch(googleUrl, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'Mozilla/5.0 TocaApp/1.0',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });

      if (!resposta.ok) continue;
      const htmlRaw = await resposta.text();
      const html = htmlRaw
        .replace(/\\u003d/g, '=')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/');

      const candidatas = [];
      const regexImagens = /https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]*)?/gi;
      let match;
      while ((match = regexImagens.exec(html)) !== null) {
        candidatas.push(match[0]);
      }

      for (const candidata of candidatas) {
        const normalizada = String(candidata || '').trim();
        if (!normalizada || vistosGoogle.has(normalizada)) continue;
        if (/google\.|gstatic\.com|youtube\.com|ytimg\.com/i.test(normalizada)) continue;

        const score = pontuarRelevancia(`${consulta} ${normalizada}`);
        if (score < (codigoValido ? 4 : 6)) continue;

        vistosGoogle.add(normalizada);
        urls.push({ url: normalizada, score });
      }
    }

    const ordenadas = urls
      .sort((a, b) => b.score - a.score)
      .map((item) => item.url);

    if (limite === null) return ordenadas;
    return ordenadas.slice(0, Math.max(5, limite));
  }

  async function buscarMelhoresImagensGoogleApi(consultas, limite = 12) {
    if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return [];

    const resultados = [];
    const vistosGoogleApi = new Set();
    const consultasValidas = Array.from(new Set((Array.isArray(consultas) ? consultas : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)));

    for (const consulta of consultasValidas) {
      const paginas = limite === null ? 3 : Math.max(1, Math.min(3, Math.ceil(Math.max(5, limite) / 10)));

      for (let pagina = 0; pagina < paginas; pagina += 1) {
        const start = (pagina * 10) + 1;
        const apiUrl = new URL('https://www.googleapis.com/customsearch/v1');
        apiUrl.searchParams.set('key', GOOGLE_CSE_API_KEY);
        apiUrl.searchParams.set('cx', GOOGLE_CSE_CX);
        apiUrl.searchParams.set('searchType', 'image');
        apiUrl.searchParams.set('safe', 'off');
        apiUrl.searchParams.set('hl', 'pt-BR');
        apiUrl.searchParams.set('num', '10');
        apiUrl.searchParams.set('start', String(start));
        apiUrl.searchParams.set('q', `${consulta} produto embalagem`);

        const resposta = await fetch(apiUrl, {
          signal: AbortSignal.timeout(5000),
          headers: {
            'User-Agent': 'Mozilla/5.0 TocaApp/1.0',
          },
        });

        if (!resposta.ok) break;

        const dados = await resposta.json();
        const items = Array.isArray(dados && dados.items) ? dados.items : [];
        if (!items.length) break;

        for (const item of items) {
          const link = String(item && item.link ? item.link : '').trim();
          const titulo = String(item && item.title ? item.title : '').toLowerCase();
          const snippet = String(item && item.snippet ? item.snippet : '').toLowerCase();
          if (!link || vistosGoogleApi.has(link)) continue;

          const score = pontuarRelevancia(`${consulta} ${titulo} ${snippet} ${link}`);
          if (score < (codigoValido ? 4 : 6)) continue;

          vistosGoogleApi.add(link);
          resultados.push({ url: link, score });
        }

        if (items.length < 10) break;
      }
    }

    const ordenadas = resultados
      .sort((a, b) => b.score - a.score)
      .map((item) => item.url);

    if (limite === null) return ordenadas;
    return ordenadas.slice(0, Math.max(5, limite));
  }

  function montarConsultasImagem() {
    const consultas = [];
    const adicionarConsulta = (partes) => {
      const texto = partes
        .map((parte) => String(parte || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (texto && !consultas.includes(texto)) consultas.push(texto);
    };

    adicionarConsulta([codigoInformado, nomeBusca, marcaBusca, saborBusca]);
    adicionarConsulta([nomeBusca, marcaBusca, saborBusca, categoriaBusca]);
    adicionarConsulta([codigoInformado, nomeBusca]);
    adicionarConsulta([codigoInformado, marcaBusca]);
    adicionarConsulta([nomeBusca, marcaBusca]);
    adicionarConsulta([codigoInformado]);
    adicionarConsulta([nomeBusca]);

    return consultas;
  }

  if (codigoValido) {
    try {
      const resposta = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json`, {
        signal: AbortSignal.timeout(4500),
      });
      if (resposta.ok) {
        const dados = await resposta.json();
        if (dados && dados.status === 1 && dados.product) {
          const p = dados.product;
          const textoOpenFoodFacts = [
            p.product_name,
            p.product_name_pt,
            p.generic_name,
            p.brands,
            p.flavors,
            p.labels,
            p.categories,
          ].filter(Boolean).join(' ');

          const scoreOff = pontuarRelevancia(textoOpenFoodFacts);
          const podeUsarOpenFoodFacts = scoreOff >= 6 || (!nomeTokens.length && !marcaTokens.length);

          if (podeUsarOpenFoodFacts) {
            adicionarOpcao(p.image_front_url, 'openfoodfacts');
            adicionarOpcao(p.image_url, 'openfoodfacts');
          }
        }
      }
    } catch (error) {
      // ignore
    }
  }

  const consultasImagem = montarConsultasImagem();
  const termoBusca = consultasImagem[0] || codigoInformado || nomeBusca || marcaBusca;
  if (podeBuscarInternet) {
    try {
      const limiteGoogle = semLimite ? null : (TOTAL_OPCOES_IMAGEM * 2);
      let melhoresGoogle = await buscarMelhoresImagensGoogleApi(consultasImagem, limiteGoogle);
      if (!melhoresGoogle.length) {
        melhoresGoogle = await buscarMelhoresImagensGoogle(consultasImagem, limiteGoogle);
      }
      melhoresGoogle.forEach((url, idx) => adicionarOpcao(url, idx === 0 ? 'google-first' : 'google-related'));
    } catch (error) {
      // ignore
    }
  }

  if (podeBuscarInternet) {
    try {
      const limiteBing = semLimite ? null : (TOTAL_OPCOES_IMAGEM * 2);
      const melhoresBing = await buscarMelhoresImagensBing(termoBusca, marcaBusca, saborBusca, categoriaBusca, limiteBing);
      melhoresBing.forEach((url, idx) => adicionarOpcao(url, idx === 0 ? 'bing-first' : 'bing-related'));
    } catch (error) {
      // ignore
    }
  }

  if (podeBuscarInternet) {
    try {
      const queryWiki = `${termoBusca} ${marcaBusca} ${saborBusca} ${categoriaBusca} produto embalagem`.trim();
      const wikiLimitePagina = semLimite ? 50 : Math.min(50, Math.max(12, TOTAL_OPCOES_IMAGEM * 3));
      const wikiPaginas = semLimite ? 5 : 1;

      for (let pagina = 0; pagina < wikiPaginas; pagina += 1) {
        const wikiOffset = pagina * wikiLimitePagina;
        const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(queryWiki)}&gsrlimit=${wikiLimitePagina}&gsroffset=${wikiOffset}&prop=imageinfo&iiprop=url|mime&format=json`;
        const resposta = await fetch(wikiUrl, { signal: AbortSignal.timeout(4500) });
        if (!resposta.ok) continue;

        const dados = await resposta.json();
        const pages = dados && dados.query && dados.query.pages ? Object.values(dados.query.pages) : [];
        for (const page of pages) {
          const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
          const mime = String(info && info.mime ? info.mime : '').toLowerCase();
          const pageTitle = String(page && page.title ? page.title : '');
          const scoreWiki = pontuarRelevancia(`${pageTitle} ${info && info.url ? info.url : ''}`);
          const scoreMinimoWiki = (exigeNomeEMarca || exigeMarcaESabor) ? 9 : 5;
          if (info && info.url && mime.startsWith('image/') && scoreWiki >= scoreMinimoWiki) {
            adicionarOpcao(info.url, 'wikimedia');
          }
        }
      }
    } catch (error) {
      // ignore
    }
  }

  const termoBase = `${nomeBusca || termoBusca || 'produto'} ${marcaBusca || ''} ${categoriaBusca || ''}`.trim();
  // Se houver limite, completa com variações locais determinísticas para manter quantidade.
  if (TOTAL_OPCOES_IMAGEM !== null) {
    let fallbackIndex = 0;
    while (opcoes.length < TOTAL_OPCOES_IMAGEM && fallbackIndex < TOTAL_OPCOES_IMAGEM + 4) {
      const sufixo = fallbackIndex === 0 ? '' : ` ${fallbackIndex + 1}`;
      adicionarOpcao(gerarSvgProdutoFallback(`${termoBase || 'produto'}${sufixo}`), 'local-fallback');
      fallbackIndex += 1;
    }
  } else if (opcoes.length === 0) {
    adicionarOpcao(gerarSvgProdutoFallback(termoBase || 'produto'), 'local-fallback');
  }

  const selecionadas = TOTAL_OPCOES_IMAGEM === null ? opcoes : opcoes.slice(0, TOTAL_OPCOES_IMAGEM);
  return res.json({
    options: selecionadas,
    relatedRequested: semLimite ? 'all' : relatedCount,
    relatedFound: Math.max(0, selecionadas.length - 1),
  });
});

app.get('/api/image-proxy', requireLogin, async (req, res) => {
  const validatedUrl = validateExternalImageUrl(req.query.url);
  if (validatedUrl.error) {
    return res.status(400).json({ error: validatedUrl.error });
  }
  const { imageUrl } = validatedUrl;

  try {
    const resposta = await fetch(imageUrl.toString(), {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': 'Mozilla/5.0 TocaApp/1.0',
      },
    });

    if (!resposta.ok) {
      return res.status(404).json({ error: 'Nao foi possivel carregar a imagem' });
    }

    const contentType = String(resposta.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL nao retornou imagem valida' });
    }

    const arquivo = Buffer.from(await resposta.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(arquivo);
  } catch (error) {
    return res.status(500).json({ error: 'Falha ao processar imagem' });
  }
});

app.get('/api/download-image', requireLogin, async (req, res) => {
  const urlParam = String(req.query.url || '').trim();
  if (!urlParam) {
    return res.status(400).json({ error: 'URL da imagem nao informada' });
  }

  let finalUrl = urlParam;
  if (urlParam.startsWith('/api/image-proxy?')) {
    const parsedProxy = new URL(urlParam, 'http://local');
    const innerUrl = String(parsedProxy.searchParams.get('url') || '').trim();
    if (!innerUrl) {
      return res.status(400).json({ error: 'URL da imagem invalida' });
    }
    finalUrl = innerUrl;
  }

  let imageUrl;
  const validatedUrl = validateExternalImageUrl(finalUrl);
  if (validatedUrl.error) {
    return res.status(400).json({ error: validatedUrl.error });
  }
  imageUrl = validatedUrl.imageUrl;

  try {
    const resposta = await fetch(imageUrl.toString(), {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': 'Mozilla/5.0 TocaApp/1.0',
      },
    });
    if (!resposta.ok) {
      return res.status(404).json({ error: 'Nao foi possivel baixar a imagem' });
    }

    const contentType = String(resposta.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL nao retornou uma imagem valida' });
    }

    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg';

    const arquivo = Buffer.from(await resposta.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="produto.${ext}"`);
    return res.send(arquivo);
  } catch (error) {
    return res.status(500).json({ error: 'Falha ao processar download da imagem' });
  }
});

app.get('/principal.html', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'principal.html'));
});

app.get('/index.html', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/gestao.html', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gestao.html'));
});

app.get('/app/:tab', requireLogin, (req, res) => {
  const tab = String(req.params.tab || '').trim();
  const vendasTabs = new Set(['estoque', 'categoriaProdutos', 'editarVenda', 'relatorioDiario']);
  const gestaoTabs = new Set(['visao', 'relatorio', 'fiados', 'associado', 'usuarios', 'entrada']);

  if (vendasTabs.has(tab)) {
    return res.redirect(`/index.html?aba=${encodeURIComponent(tab)}&solo=1`);
  }

  if (gestaoTabs.has(tab)) {
    return res.redirect(`/gestao.html?aba=${encodeURIComponent(tab)}&solo=1`);
  }

  return res.status(404).send('Aba não encontrada');
});

// protect main page
app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'principal.html'));
});

// Routes
const productsRouter = require('./routes/products');
app.use('/api/products', requireLogin, productsRouter);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startAutoBackupScheduler();
});