const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 's3cr3t-local';
const isProduction = process.env.NODE_ENV === 'production';
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

// Setup LowDB
const file = String(process.env.DB_FILE || '').trim() || path.join(__dirname, 'db.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const adapter = new JSONFile(file);
const db = new Low(adapter, { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null });

async function initDB() {
  try {
    await ensureDbLoaded();
  } catch (error) {
    console.error('Falha ao inicializar banco de dados:', error.message);
    db.data = { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
    ensureDbShape();
    await db.write();
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
  try {
    await db.read();
  } catch (error) {
    console.error('Falha ao ler db.json, recriando base:', error.message);
    db.data = { products: [], users: [], vendas: [], associados: [], vendaCounter: 1, lastSaleId: null };
    ensureDbShape();
    await db.write();
    return;
  }

  const before = JSON.stringify(db.data || {});
  ensureDbShape();
  const bootstrapCriado = ensureBootstrapAdmin();
  if (bootstrapCriado || before !== JSON.stringify(db.data || {})) {
    await db.write();
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
      await db.write();
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

  await db.write();
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
  await db.write();

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

  await db.write();
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
  await db.write();
  return res.status(204).end();
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