# CSSPP - Sistema de Vendas e Estoque

Aplicacao web em Node.js + Express para controle de vendas, estoque, fiado, associados e usuarios.

## Requisitos

- Node.js 18+ (recomendado LTS)
- npm 9+

## Estrutura principal

- `server.js`: servidor Express, sessao e APIs
- `routes/products.js`: rotas de produtos
- `public/`: telas (`login.html`, `index.html`, `gestao.html`)
- `db.json`: base de dados local (nao versionada)
- `db.example.json`: modelo de base para inicializacao

## Configuracao inicial

1. Instale dependencias:
   ```sh
   npm install
   ```
2. Crie o arquivo de dados a partir do exemplo:
   ```powershell
   Copy-Item db.example.json db.json
   ```

## Primeiro acesso (importante)

O login depende de usuarios existentes em `db.json`.
Se sua base estiver vazia, crie manualmente um admin em `db.json` antes de abrir o sistema.

Exemplo de usuario admin:

```json
{
  "id": "admin-inicial",
  "nome": "ADMIN",
  "cpf": "000.000.000-00",
  "senha": "1234",
  "perfil": "admin",
  "ativo": true,
  "criadoEm": "2026-01-01T00:00:00.000Z"
}
```

Insira esse objeto dentro de `users` no `db.json`.
Depois de entrar, altere credenciais para dados reais.

## Rodando localmente

### Producao local

```sh
npm start
```

### Desenvolvimento (com nodemon)

```sh
npm run dev
```

Em PowerShell, se `npm` falhar por policy, use:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Abra no navegador:

```text
http://localhost:3000
```

## Variaveis de ambiente

- `PORT`: porta HTTP (padrao `3000`)
- `SESSION_SECRET`: segredo da sessao (obrigatorio em producao)
- `NODE_ENV`: use `production` em deploy
- `BOOTSTRAP_ADMIN_CPF`: CPF do primeiro admin (somente quando banco estiver sem usuarios)
- `BOOTSTRAP_ADMIN_SENHA`: senha do primeiro admin
- `BOOTSTRAP_ADMIN_NOME`: nome do primeiro admin (opcional, padrao `ADMIN`)
- `DATABASE_URL`: conexao PostgreSQL (Neon/Supabase/Render Postgres)
- `PGSSLMODE`: opcional (`disable` para ambiente local sem SSL)
- `AUTO_BACKUP_INTERVAL_MINUTES`: intervalo do backup automatico em minutos (padrao `1440`, 1x por dia; `0` desativa)
- `AUTO_BACKUP_RETENTION`: quantidade maxima de backups mantidos (padrao `30`)
- `AUTO_BACKUP_ON_START`: cria backup apos iniciar servidor (`true`/`false`, padrao `true`)
- `BACKUP_DIR`: pasta dos backups (opcional; se omitido, usa pasta gravavel automatica)

Exemplo PowerShell:

```powershell
$env:SESSION_SECRET="chave-longa-segura"
$env:NODE_ENV="production"
npm start
```

## Deploy

### Railway

1. `New Project` > `Deploy from GitHub repo`
2. Selecione o repositorio
3. Configure env vars:
   - `SESSION_SECRET`
   - `NODE_ENV=production`
4. Start command:
   ```sh
   npm start
   ```

### Render

1. Criar `Web Service` conectado ao GitHub
2. Build command:
   ```sh
   npm install
   ```
3. Start command:
   ```sh
   npm start
   ```
4. Configurar `SESSION_SECRET` e `NODE_ENV=production`

Para primeiro acesso em deploy novo, adicione tambem:

- `BOOTSTRAP_ADMIN_CPF=00000000000`
- `BOOTSTRAP_ADMIN_SENHA=1234`
- `BOOTSTRAP_ADMIN_NOME=ADMIN`

Depois do primeiro login e criacao de usuarios reais, voce pode remover `BOOTSTRAP_ADMIN_SENHA`.

Se aparecer `Credenciais inválidas` no Render, mantendo essas variaveis configuradas, o backend agora recria/reativa automaticamente o admin bootstrap no login.

### Render (Blueprint 1-clique)

Este repositorio inclui `render.yaml`.

1. No Render, clique em `New` -> `Blueprint`.
2. Selecione o repositorio `dioginlopez/Sistema-Vendas`.
3. Confirme a criacao do servico.

Com isso, o Render aplica automaticamente:

- `buildCommand`: `npm install`
- `startCommand`: `npm start`
- `NODE_ENV=production`
- `SESSION_SECRET` gerado automaticamente
- Banco PostgreSQL gerenciado (`sistema-vendas-db`)
- Disco persistente montado em `/var/data`
- `DB_FILE=/var/data/db.json` para persistir LowDB entre deploys/restarts
- `DATABASE_URL` ligado automaticamente ao PostgreSQL

Observacao importante:

- A aplicacao atual usa `LowDB` (`db.json`) como banco principal.
- O PostgreSQL criado no Blueprint fica pronto para uma migracao futura (ja com `DATABASE_URL` no ambiente).

## Persistencia de dados

- Os dados ficam em `db.json`.
- Em Render, o arquivo e persistido no disco (`/var/data/db.json`).
- Sem persistencia, os dados se perdem em restart/redeploy.

## Backups automaticos (servidor)

O backend agora gera backups JSON automaticamente e mantem retencao configuravel.

- Padrao: 1 backup por dia (`AUTO_BACKUP_INTERVAL_MINUTES=1440`)
- Retencao padrao: 30 arquivos (`AUTO_BACKUP_RETENTION=30`)
- Backup inicial ao subir app: ativo por padrao (`AUTO_BACKUP_ON_START=true`)

Rotas admin:

- `GET /api/backups` lista backups disponiveis
- `POST /api/backups` cria backup manual imediato
- `GET /api/backups/latest/download` baixa o backup mais recente
- `GET /api/backups/:name/download` baixa backup especifico

### Persistencia automatica em PostgreSQL (recomendado no plano free)

Se `DATABASE_URL` estiver configurada, o backend sincroniza automaticamente o estado da aplicacao no PostgreSQL a cada gravacao.

- Isso garante persistencia mesmo sem disco no Render free.
- `db.json` continua como fallback/local.

## GitHub e arquivos sensiveis

`db.json` esta no `.gitignore` para evitar publicar dados reais.
Suba apenas `db.example.json` como modelo.

## Seguranca recomendada

- Nao manter senha padrao em producao
- Manter pelo menos um usuario admin ativo
- Rotacionar senhas periodicamente
