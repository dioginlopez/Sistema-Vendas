const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 's3cr3t-local';
const isProduction = process.env.NODE_ENV === 'production';
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const BOOTSTRAP_ADMIN_CPF = normalizeCpf(process.env.BOOTSTRAP_ADMIN_CPF || '');
const BOOTSTRAP_ADMIN_SENHA = String(process.env.BOOTSTRAP_ADMIN_SENHA || '');
const BOOTSTRAP_ADMIN_NOME = String(process.env.BOOTSTRAP_ADMIN_NOME || 'ADMIN').trim() || 'ADMIN';

if (isProduction) {
  // Allow secure cookies behind reverse proxies (Railway/Render).
  app.set('trust proxy', 1);
}

function normalizeCpf(cpf) {
  return String(cpf || '').replace(/\D/g, '');
}

function isAdminUser(user) {
  return user && (user.perfil || 'operador') === 'admin' && user.ativo !== false;
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

async function persistDb() {
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

function ensureBootstrapAdmin() {
  if (!Array.isArray(db.data.users) || db.data.users.length > 0) {
    return false;
  }

  if (!BOOTSTRAP_ADMIN_CPF || !BOOTSTRAP_ADMIN_SENHA) {
    return false;
  }

  if (BOOTSTRAP_ADMIN_SENHA.length < 4) {
    console.warn('BOOTSTRAP_ADMIN_SENHA ignorada: senha deve ter pelo menos 4 caracteres.');
    return false;
  }

  const novoAdmin = {
    id: nanoid(),
    nome: BOOTSTRAP_ADMIN_NOME,
    cpf: BOOTSTRAP_ADMIN_CPF,
    senha: BOOTSTRAP_ADMIN_SENHA,
    perfil: 'admin',
    ativo: true,
    criadoEm: new Date().toISOString(),
  };

  db.data.users.push(novoAdmin);
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
    maxAge: 1000 * 60 * 60 * 12,
  },
}))

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    // Modo recuperação: se não houver admin ativo no banco, libera esta sessão como admin.
    const existeAdminAtivo = db.data.users.some((u) => isAdminUser(u));
    if (!existeAdminAtivo) {
      req.session.user = {
        ...(req.session.user || {}),
        perfil: 'admin',
      };
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
    const existeAdminAtivo = db.data.users.some((u) => isAdminUser(u));

    // Modo recuperação: sem admin ativo, permitir gestão de usuários para recriar acesso.
    if (!existeAdminAtivo) {
      return next();
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
  const bootstrapCriado = ensureBootstrapAdmin();
  if (bootstrapCriado || before !== JSON.stringify(db.data || {}) || shouldPersist) {
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
        user.senha = BOOTSTRAP_ADMIN_SENHA;
      } else {
        user = {
          id: nanoid(),
          nome: BOOTSTRAP_ADMIN_NOME,
          cpf: BOOTSTRAP_ADMIN_CPF,
          senha: BOOTSTRAP_ADMIN_SENHA,
          perfil: 'admin',
          ativo: true,
          criadoEm: new Date().toISOString(),
        };
        db.data.users.push(user);
      }
      await persistDb();
    }

    if (user && user.senha === senha && user.ativo !== false) {
      req.session.loggedIn = true;
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

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login.html');
  });
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.session.user || null });
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

app.put('/api/state', requireLogin, async (req, res) => {
  await ensureDbLoaded();

  const {
    produtos,
    vendas,
    associados,
    vendaCounter,
    lastSaleId,
  } = req.body || {};

  if (!Array.isArray(produtos) || !Array.isArray(vendas) || !Array.isArray(associados)) {
    return res.status(400).json({ error: 'Estado inválido: produtos, vendas e associados devem ser listas' });
  }

  const vendaCounterFinal = Number.isFinite(Number(vendaCounter)) && Number(vendaCounter) > 0
    ? Number(vendaCounter)
    : 1;

  db.data.products = produtos;
  db.data.vendas = vendas;
  db.data.associados = associados;
  db.data.vendaCounter = vendaCounterFinal;
  db.data.lastSaleId = lastSaleId ?? null;

  await persistDb();
  return res.json({ ok: true });
});

app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
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
    id: nanoid(),
    nome: nomeLimpo,
    cpf: cpfLimpo,
    senha: senhaLimpa,
    perfil: perfilFinal,
    ativo: ativo !== false,
    criadoEm: new Date().toISOString(),
  };

  db.data.users.push(novoUsuario);
  await persistDb();

  const { senha: _, ...safeUser } = novoUsuario;
  return res.status(201).json(safeUser);
});

app.put('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
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
    user.senha = senha;
  }

  await persistDb();
  const { senha: _, ...safeUser } = user;
  return res.json(safeUser);
});

app.delete('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
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
  const codigo = normalizeCpf(String(req.query.codigo || '')).trim();

  if (!nome && !codigo) {
    return res.status(400).json({ error: 'Informe nome ou codigo do produto' });
  }

  let imageUrl = '';
  let source = '';
  const termoFallback = String(nome || codigo || 'produto').trim();

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

  if (codigo) {
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

  if (!imageUrl && nome) {
    try {
      imageUrl = await buscarImagemWikimedia(nome);
      source = imageUrl ? 'wikimedia-name' : source;
    } catch (error) {
      // Silent fallback.
    }
  }

  if (!imageUrl && codigo) {
    try {
      imageUrl = await buscarImagemWikimedia(codigo);
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

app.get('/api/image-proxy', requireLogin, async (req, res) => {
  const urlParam = String(req.query.url || '').trim();
  if (!urlParam) {
    return res.status(400).json({ error: 'URL da imagem nao informada' });
  }

  let imageUrl;
  try {
    imageUrl = new URL(urlParam);
  } catch (error) {
    return res.status(400).json({ error: 'URL da imagem invalida' });
  }

  if (!['http:', 'https:'].includes(imageUrl.protocol)) {
    return res.status(400).json({ error: 'Protocolo de URL nao permitido' });
  }

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
  try {
    imageUrl = new URL(finalUrl);
  } catch (error) {
    return res.status(400).json({ error: 'URL da imagem invalida' });
  }

  if (!['http:', 'https:'].includes(imageUrl.protocol)) {
    return res.status(400).json({ error: 'Protocolo de URL nao permitido' });
  }

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

// protect main page
app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Routes
const productsRouter = require('./routes/products');
app.use('/api/products', requireLogin, productsRouter);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});