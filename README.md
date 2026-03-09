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

## Persistencia de dados

- Os dados ficam em `db.json`.
- Em nuvem, use volume/disco persistente.
- Sem persistencia, os dados se perdem em restart/redeploy.

## GitHub e arquivos sensiveis

`db.json` esta no `.gitignore` para evitar publicar dados reais.
Suba apenas `db.example.json` como modelo.

## Seguranca recomendada

- Nao manter senha padrao em producao
- Manter pelo menos um usuario admin ativo
- Rotacionar senhas periodicamente
