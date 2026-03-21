# Toca Mobile (copia do sistema atual)

Esta pasta contem uma copia mobile separada do sistema, sem apagar ou alterar os arquivos originais.

## O que foi criado

- App Android com Capacitor em `mobile-app/android`
- Copia do frontend em `mobile-app/www` (baseado em `../public`)
- Configuracao para carregar o backend em `http://10.0.2.2:3000` (emulador Android)

## Como usar

1. No projeto principal, mantenha o backend rodando:
   - `npm run dev`
2. Na pasta `mobile-app`, sincronize a copia web:
   - `npm run build:mobile`
3. Abra o projeto Android:
   - `npm run android`
4. No Android Studio, execute em emulador/dispositivo.

## Modo automatico (1 comando)

Para detectar automaticamente o IP local do PC, atualizar o `capacitor.config.json`, copiar o frontend e sincronizar Android:

- `npm run auto:mobile`

Para fazer tudo acima e abrir direto no Android Studio:

- `npm run auto:android`

Para gerar tudo e instalar no celular/emulador em uma etapa:

- `npm run auto:full`

Para apenas instalar o APK ja gerado (sem rebuild):

- `npm run install:apk`

## App permanente no celular (release)

Para deixar permanente, o app precisa usar URL de producao e APK release assinada.

Comando automatico completo:

- `npm run release:all`

Esse comando:

- aplica a logo do app
- configura URL de producao (`https://sistema-vendas-58s2.onrender.com`)
- sincroniza arquivos web
- cria/usa keystore de release
- gera APK release assinada
- instala no celular conectado

Se quiser somente gerar a APK release (sem instalar):

- `npm run release:apk`

Se quiser instalar depois a APK release ja gerada:

- `npm run release:install`

## URL do servidor no celular

A URL em `capacitor.config.json` passa a ser atualizada automaticamente pelo script `auto:mobile`.

Se o script nao conseguir detectar IP local, ele usa fallback para emulador Android:

- `http://10.0.2.2:3000`

Para celular fisico, troque para o IP da maquina na rede local, por exemplo:

- `http://192.168.0.25:3000`

Depois de alterar, rode:

- `npm run sync`

## Atualizar quando mudar o frontend

Sempre que editar arquivos em `public`, rode em `mobile-app`:

- `npm run build:mobile`

Isso recopia os arquivos para `www` e sincroniza no Android.
