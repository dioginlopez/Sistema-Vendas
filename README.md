# CSSPP - Sistema de Vendas e Estoque

Aplicacao em Node.js/Express para controle de vendas, estoque, fiado, associados e usuarios.

## Executar localmente

1. Instale as dependencias:
   ```sh
   npm install
   ```
2. Inicie o servidor:
   ```sh
   npm start
   ```
3. Acesse:
   ```text
   http://localhost:3000
   ```

## Variaveis de ambiente

- `PORT`: porta HTTP do servidor (opcional em desenvolvimento).
- `SESSION_SECRET`: segredo da sessao (obrigatorio em producao).
- `NODE_ENV`: use `production` em ambiente publicado.

Exemplo (PowerShell):

```powershell
$env:SESSION_SECRET="uma-chave-longa-e-segura"
$env:NODE_ENV="production"
npm start
```

## Publicacao (Railway)

1. Suba o projeto para um repositorio no GitHub.
2. No Railway, clique em `New Project` > `Deploy from GitHub repo`.
3. Selecione o repositorio.
4. Configure as variaveis:
   - `SESSION_SECRET` = chave longa aleatoria
   - `NODE_ENV` = `production`
5. Start command:
   ```sh
   npm start
   ```
6. Abra a URL gerada pelo Railway.

## Publicacao (Render)

1. Crie um `Web Service` conectado ao GitHub.
2. Build command:
   ```sh
   npm install
   ```
3. Start command:
   ```sh
   npm start
   ```
4. Configure `SESSION_SECRET` e `NODE_ENV=production`.

## Persistencia de dados

- O backend salva os dados em `db.json`.
- Em nuvem, confirme que o servidor possui disco persistente/volume.
- Sem disco persistente, os dados podem ser perdidos apos reinicio/redeploy.

## Funcionalidades principais

- Login por CPF/senha com sessao.
- Controle de perfil (`admin` e `operador`).
- Cadastro e venda de produtos.
- Carrinho, desconto, formas de pagamento e fiado.
- Edicao de venda por numero.
- Gestao de associados e usuarios.
- Relatorios e backup/restauracao.

## Seguranca de acesso

- Nao utilize credenciais padrao.
- Mantenha pelo menos um usuario administrador ativo no sistema.
- Recomendacao: altere periodicamente as senhas de acesso.
