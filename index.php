<?php
declare(strict_types=1);

session_name('toca_session');
session_start();

date_default_timezone_set('UTC');

const TOCA_DEFAULT_STATE = [
    'products' => [],
    'users' => [],
    'vendas' => [],
    'associados' => [],
    'vendaCounter' => 1,
    'lastSaleId' => null,
];

final class TocaApp
{
    private string $rootDir;
    private string $publicDir;
    private string $dbFile;
    private string $backupDir;
    private string $databaseUrl;
    private bool $isProduction;
    private string $appVersion;
    private string $appCommit;
    private string $appBootTime;
    private int $passwordHashRounds;
    private string $bootstrapAdminCpf;
    private string $bootstrapAdminSenha;
    private string $bootstrapAdminNome;
    private ?PDO $pdo = null;
    private ?array $stateCache = null;

    public function __construct()
    {
        $this->rootDir = __DIR__;
        $this->publicDir = $this->rootDir . DIRECTORY_SEPARATOR . 'public';
        $this->dbFile = $this->resolveWritableDbFile();
        $this->backupDir = $this->resolveWritableBackupDir();
        $this->databaseUrl = trim((string) getenv('DATABASE_URL'));
        $this->isProduction = strtolower(trim((string) getenv('NODE_ENV'))) === 'production'
            || strtolower(trim((string) getenv('APP_ENV'))) === 'production';
        $this->appVersion = $this->loadPackageVersion();
        $this->appCommit = trim((string) (getenv('RENDER_GIT_COMMIT') ?: getenv('COMMIT_SHA') ?: '')) ?: 'local';
        $this->appBootTime = gmdate('c');
        $this->passwordHashRounds = max(8, (int) (getenv('PASSWORD_HASH_ROUNDS') ?: 10));
        $this->bootstrapAdminCpf = $this->normalizeCpf((string) getenv('BOOTSTRAP_ADMIN_CPF'));
        $this->bootstrapAdminSenha = (string) (getenv('BOOTSTRAP_ADMIN_SENHA') ?: '');
        $this->bootstrapAdminNome = trim((string) (getenv('BOOTSTRAP_ADMIN_NOME') ?: 'ADMIN')) ?: 'ADMIN';
    }

    public function run(): void
    {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $path = rawurldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');

        if ($method === 'GET' && $this->serveProtectedPage($path)) {
            return;
        }

        if ($method === 'POST' && $path === '/login') {
            $this->handleLogin();
            return;
        }

        if ($method === 'POST' && $path === '/logout') {
            $this->requireLogin($path);
            $this->requireCsrf();
            $this->destroySession();
            $this->redirect('/login.html');
            return;
        }

        if ($method === 'POST' && $path === '/logout-beacon') {
            $this->requireLogin($path);
            $this->requireCsrf();
            $this->destroySession();
            http_response_code(204);
            return;
        }

        if ($path === '/api/version' && $method === 'GET') {
            $this->jsonResponse([
                'version' => $this->appVersion,
                'commit' => $this->appCommit,
                'bootTime' => $this->appBootTime,
                'env' => $this->isProduction ? 'production' : 'development',
            ]);
            return;
        }

        if ($path === '/api/me' && $method === 'GET') {
            $this->requireLogin($path);
            $this->jsonResponse([
                'user' => $_SESSION['user'] ?? null,
                'csrfToken' => $this->ensureSessionCsrfToken(),
            ]);
            return;
        }

        if ($path === '/api/state' && $method === 'GET') {
            $this->requireLogin($path);
            $state = $this->loadState();
            $this->jsonResponse([
                'produtos' => array_values($state['products']),
                'vendas' => array_values($state['vendas']),
                'associados' => array_values($state['associados']),
                'vendaCounter' => (int) $state['vendaCounter'],
                'lastSaleId' => $state['lastSaleId'],
            ]);
            return;
        }

        if ($path === '/api/state' && $method === 'PUT') {
            $this->requireLogin($path);
            $this->requireCsrf();
            $payload = $this->readJsonBody();
            $sanitized = $this->sanitizeIncomingState($payload);
            if (isset($sanitized['error'])) {
                $this->jsonResponse(['error' => $sanitized['error']], 400);
            }

            $state = $this->loadState();
            $state['products'] = $sanitized['state']['products'];
            $state['vendas'] = $sanitized['state']['vendas'];
            $state['associados'] = $sanitized['state']['associados'];
            $state['vendaCounter'] = $sanitized['state']['vendaCounter'];
            $state['lastSaleId'] = $sanitized['state']['lastSaleId'];
            $this->persistState($state);
            $this->jsonResponse(['ok' => true]);
            return;
        }

        if ($path === '/api/state/flush' && $method === 'POST') {
            $this->requireLogin($path);
            $this->requireCsrf();
            $payload = $this->readFlexibleBody();
            $sanitized = $this->sanitizeIncomingState($payload);
            if (isset($sanitized['error'])) {
                $this->jsonResponse(['error' => $sanitized['error']], 400);
            }

            $state = $this->loadState();
            $state['products'] = $sanitized['state']['products'];
            $state['vendas'] = $sanitized['state']['vendas'];
            $state['associados'] = $sanitized['state']['associados'];
            $state['vendaCounter'] = $sanitized['state']['vendaCounter'];
            $state['lastSaleId'] = $sanitized['state']['lastSaleId'];
            $this->persistState($state);
            $this->jsonResponse(['ok' => true]);
            return;
        }

        if ($path === '/api/users' && $method === 'GET') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $state = $this->loadState();
            $users = array_map(static function (array $user): array {
                unset($user['senha']);
                return $user;
            }, $state['users']);
            $this->jsonResponse($users);
            return;
        }

        if ($path === '/api/users' && $method === 'POST') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $this->requireCsrf();
            $this->handleCreateUser();
            return;
        }

        if (preg_match('#^/api/users/([^/]+)$#', $path, $matches) === 1) {
            $this->requireLogin($path);
            $this->requireAdmin();
            if ($method === 'PUT') {
                $this->requireCsrf();
                $this->handleUpdateUser($matches[1]);
                return;
            }

            if ($method === 'DELETE') {
                $this->requireCsrf();
                $this->handleDeleteUser($matches[1]);
                return;
            }
        }

        if ($path === '/api/backups' && $method === 'GET') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $items = array_map(static function (array $item): array {
                return [
                    'name' => $item['name'],
                    'size' => $item['size'],
                    'createdAt' => $item['createdAt'],
                    'modifiedAt' => $item['modifiedAt'],
                ];
            }, $this->listBackupFiles());
            $this->jsonResponse(['backups' => $items]);
            return;
        }

        if ($path === '/api/backups' && $method === 'POST') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $this->requireCsrf();
            $backup = $this->createBackup('manual');
            $this->jsonResponse([
                'ok' => true,
                'fileName' => $backup['fileName'],
                'createdAt' => $backup['createdAt'],
            ], 201);
            return;
        }

        if ($path === '/api/backups/latest/download' && $method === 'GET') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $backups = $this->listBackupFiles();
            if ($backups === []) {
                $this->jsonResponse(['error' => 'Nenhum backup encontrado'], 404);
            }
            $this->sendJsonDownload($backups[0]['fullPath'], $backups[0]['name']);
            return;
        }

        if (preg_match('#^/api/backups/([^/]+)/download$#', $path, $matches) === 1 && $method === 'GET') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $requestedName = basename($matches[1]);
            if (!str_ends_with($requestedName, '.json')) {
                $this->jsonResponse(['error' => 'Nome de backup invalido'], 400);
            }

            $fullPath = $this->backupDir . DIRECTORY_SEPARATOR . $requestedName;
            if (!is_file($fullPath)) {
                $this->jsonResponse(['error' => 'Backup nao encontrado'], 404);
            }

            $this->sendJsonDownload($fullPath, $requestedName);
            return;
        }

        if ($path === '/api/product-image' && $method === 'GET') {
            $this->requireLogin($path);
            $this->handleProductImage();
            return;
        }

        if ($path === '/api/product-image-options' && $method === 'GET') {
            $this->requireLogin($path);
            $this->handleProductImageOptions();
            return;
        }

        if ($path === '/api/image-proxy' && $method === 'GET') {
            $this->requireLogin($path);
            $this->handleImageProxy();
            return;
        }

        if ($path === '/api/download-image' && $method === 'GET') {
            $this->requireLogin($path);
            $this->handleImageDownload();
            return;
        }

        if ($path === '/api/products' && $method === 'GET') {
            $this->requireLogin($path);
            $state = $this->loadState();
            $this->jsonResponse(array_values($state['products']));
            return;
        }

        if ($path === '/api/products' && $method === 'POST') {
            $this->requireLogin($path);
            $this->requireAdmin();
            $this->requireCsrf();
            $this->handleCreateProduct();
            return;
        }

        if (preg_match('#^/api/products/([^/]+)$#', $path, $matches) === 1) {
            $this->requireLogin($path);
            if ($method === 'GET') {
                $this->handleGetProduct($matches[1]);
                return;
            }

            if ($method === 'PUT') {
                $this->requireAdmin();
                $this->requireCsrf();
                $this->handleUpdateProduct($matches[1]);
                return;
            }

            if ($method === 'DELETE') {
                $this->requireAdmin();
                $this->requireCsrf();
                $this->handleDeleteProduct($matches[1]);
                return;
            }
        }

        if ($method === 'GET' && preg_match('#^/app/([^/]+)$#', $path, $matches) === 1) {
            $this->requireLogin($path);
            $this->handleAppTabRedirect($matches[1]);
            return;
        }

        if ($method === 'GET' && $this->servePublicAsset($path)) {
            return;
        }

        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Rota nao encontrada';
    }

    private function handleLogin(): void
    {
        $body = $this->readFlexibleBody();
        $cpf = $this->normalizeCpf((string) ($body['cpf'] ?? ''));
        $senha = (string) ($body['senha'] ?? '');
        $expectsJson = $this->expectsJson();
        $state = $this->loadState();

        $user = null;
        foreach ($state['users'] as $candidate) {
            if ($this->normalizeCpf((string) ($candidate['cpf'] ?? '')) === $cpf) {
                $user = $candidate;
                break;
            }
        }

        $bootstrapAllowed = $this->bootstrapAdminCpf !== '' && $this->bootstrapAdminSenha !== ''
            && $cpf === $this->bootstrapAdminCpf
            && $senha === $this->bootstrapAdminSenha;

        if ($bootstrapAllowed) {
            $updated = false;
            if ($user !== null) {
                foreach ($state['users'] as &$item) {
                    if (($item['id'] ?? null) === $user['id']) {
                        $item['nome'] = $this->bootstrapAdminNome;
                        $item['perfil'] = 'admin';
                        $item['ativo'] = true;
                        $item['senha'] = $this->hashPassword($this->bootstrapAdminSenha);
                        $user = $item;
                        $updated = true;
                        break;
                    }
                }
                unset($item);
            }

            if (!$updated) {
                $user = [
                    'id' => $this->generateId(),
                    'nome' => $this->bootstrapAdminNome,
                    'cpf' => $this->bootstrapAdminCpf,
                    'senha' => $this->hashPassword($this->bootstrapAdminSenha),
                    'perfil' => 'admin',
                    'ativo' => true,
                    'criadoEm' => gmdate('c'),
                ];
                $state['users'][] = $user;
            }

            $this->persistState($state);
        }

        if ($user !== null) {
            $passwordCheck = $this->verifyUserPassword((string) ($user['senha'] ?? ''), $senha);
            if ($passwordCheck['match'] && (($user['ativo'] ?? true) !== false)) {
                if ($passwordCheck['shouldUpgrade']) {
                    foreach ($state['users'] as &$item) {
                        if (($item['id'] ?? null) === $user['id']) {
                            $item['senha'] = $this->hashPassword($senha);
                            $user['senha'] = $item['senha'];
                            break;
                        }
                    }
                    unset($item);
                    $this->persistState($state);
                }

                $_SESSION['loggedIn'] = true;
                $_SESSION['user'] = [
                    'id' => $user['id'],
                    'nome' => $user['nome'],
                    'cpf' => $user['cpf'],
                    'perfil' => $user['perfil'] ?? 'operador',
                ];
                $this->ensureSessionCsrfToken();

                if ($expectsJson) {
                    $this->jsonResponse(['ok' => true, 'redirect' => '/']);
                }
                $this->redirect('/');
            }
        }

        if ($expectsJson) {
            $this->jsonResponse(['error' => 'Credenciais invalidas'], 401);
        }

        http_response_code(401);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Credenciais invalidas';
    }

    private function handleCreateUser(): void
    {
        $body = $this->readJsonBody();
        $state = $this->loadState();
        $nome = trim((string) ($body['nome'] ?? ''));
        $cpf = trim((string) ($body['cpf'] ?? ''));
        $senha = (string) ($body['senha'] ?? '');
        $perfil = (($body['perfil'] ?? 'operador') === 'admin') ? 'admin' : 'operador';
        $ativo = ($body['ativo'] ?? true) !== false;
        $cpfNormalizado = $this->normalizeCpf($cpf);

        if ($nome === '' || $cpfNormalizado === '' || $senha === '') {
            $this->jsonResponse(['error' => 'Nome, CPF e senha sao obrigatorios'], 400);
        }
        if (strlen($senha) < 4) {
            $this->jsonResponse(['error' => 'Senha deve ter pelo menos 4 caracteres'], 400);
        }

        foreach ($state['users'] as $user) {
            if ($this->normalizeCpf((string) ($user['cpf'] ?? '')) === $cpfNormalizado) {
                $this->jsonResponse(['error' => 'Ja existe usuario com este CPF'], 409);
            }
        }

        $newUser = [
            'id' => $this->generateId(),
            'nome' => $nome,
            'cpf' => $cpf,
            'senha' => $this->hashPassword($senha),
            'perfil' => $perfil,
            'ativo' => $ativo,
            'criadoEm' => gmdate('c'),
        ];

        $state['users'][] = $newUser;
        $this->persistState($state);
        unset($newUser['senha']);
        $this->jsonResponse($newUser, 201);
    }

    private function handleUpdateUser(string $id): void
    {
        $body = $this->readJsonBody();
        $state = $this->loadState();
        $index = $this->findIndexById($state['users'], $id);
        if ($index < 0) {
            $this->jsonResponse(['error' => 'Usuario nao encontrado'], 404);
        }

        $nome = trim((string) ($body['nome'] ?? ''));
        $cpf = trim((string) ($body['cpf'] ?? ''));
        $senha = (string) ($body['senha'] ?? '');
        $perfil = (($body['perfil'] ?? 'operador') === 'admin') ? 'admin' : 'operador';
        $ativo = ($body['ativo'] ?? true) !== false;
        $cpfNormalizado = $this->normalizeCpf($cpf);
        if ($nome === '' || $cpfNormalizado === '') {
            $this->jsonResponse(['error' => 'Nome e CPF sao obrigatorios'], 400);
        }

        foreach ($state['users'] as $position => $user) {
            if ($position !== $index && $this->normalizeCpf((string) ($user['cpf'] ?? '')) === $cpfNormalizado) {
                $this->jsonResponse(['error' => 'Ja existe usuario com este CPF'], 409);
            }
        }

        $totalAdminsAtivos = count(array_filter($state['users'], fn (array $user): bool => $this->isAdminUser($user)));
        $userAtual = $state['users'][$index];
        $eraAdminAtivo = $this->isAdminUser($userAtual);
        $continuaraAdminAtivo = $perfil === 'admin' && $ativo;
        if ($eraAdminAtivo && !$continuaraAdminAtivo && $totalAdminsAtivos <= 1) {
            $this->jsonResponse(['error' => 'Nao e permitido remover ou desativar o ultimo administrador'], 400);
        }

        $state['users'][$index]['nome'] = $nome;
        $state['users'][$index]['cpf'] = $cpf;
        $state['users'][$index]['perfil'] = $perfil;
        $state['users'][$index]['ativo'] = $ativo;
        if ($senha !== '') {
            if (strlen($senha) < 4) {
                $this->jsonResponse(['error' => 'Senha deve ter pelo menos 4 caracteres'], 400);
            }
            $state['users'][$index]['senha'] = $this->hashPassword($senha);
        }

        $this->persistState($state);
        $safeUser = $state['users'][$index];
        unset($safeUser['senha']);
        $this->jsonResponse($safeUser);
    }

    private function handleDeleteUser(string $id): void
    {
        $state = $this->loadState();
        if ((string) ($_SESSION['user']['id'] ?? '') === $id) {
            $this->jsonResponse(['error' => 'Voce nao pode remover seu proprio usuario'], 400);
        }

        $index = $this->findIndexById($state['users'], $id);
        if ($index < 0) {
            $this->jsonResponse(['error' => 'Usuario nao encontrado'], 404);
        }

        $user = $state['users'][$index];
        $totalAdminsAtivos = count(array_filter($state['users'], fn (array $item): bool => $this->isAdminUser($item)));
        if ($this->isAdminUser($user) && $totalAdminsAtivos <= 1) {
            $this->jsonResponse(['error' => 'Nao e permitido remover o ultimo administrador'], 400);
        }

        array_splice($state['users'], $index, 1);
        $this->persistState($state);
        http_response_code(204);
    }

    private function handleCreateProduct(): void
    {
        $body = $this->readJsonBody();
        $state = $this->loadState();
        $normalized = $this->normalizeProductPayload($body, null);
        if (isset($normalized['error'])) {
            $this->jsonResponse(['error' => $normalized['error']], 400);
        }
        $state['products'][] = $normalized;
        $this->persistState($state);
        $this->jsonResponse($normalized, 201);
    }

    private function handleGetProduct(string $id): void
    {
        $state = $this->loadState();
        foreach ($state['products'] as $product) {
            if ((string) ($product['id'] ?? '') === $id) {
                $this->jsonResponse($product);
            }
        }
        $this->jsonResponse(['error' => 'Product not found'], 404);
    }

    private function handleUpdateProduct(string $id): void
    {
        $body = $this->readJsonBody();
        $state = $this->loadState();
        $index = $this->findIndexById($state['products'], $id);
        if ($index < 0) {
            $this->jsonResponse(['error' => 'Product not found'], 404);
        }
        $normalized = $this->normalizeProductPayload($body, $state['products'][$index]);
        if (isset($normalized['error'])) {
            $this->jsonResponse(['error' => $normalized['error']], 400);
        }

        $state['products'][$index] = $normalized;
        $this->persistState($state);
        $this->jsonResponse($normalized);
    }

    private function handleDeleteProduct(string $id): void
    {
        $state = $this->loadState();
        $index = $this->findIndexById($state['products'], $id);
        if ($index < 0) {
            $this->jsonResponse(['error' => 'Product not found'], 404);
        }

        array_splice($state['products'], $index, 1);
        $this->persistState($state);
        http_response_code(204);
    }

    private function handleProductImage(): void
    {
        $state = $this->loadState();
        $nome = trim((string) ($_GET['nome'] ?? ''));
        $codigoInformado = trim((string) ($_GET['codigo'] ?? ''));
        $codigo = $this->normalizeCpf($codigoInformado);
        $marcaBusca = '';

        if ($codigoInformado !== '' && $nome === '') {
            $produtoLocal = $this->findProductByAnyCode($state, $codigoInformado);
            if ($produtoLocal !== null) {
                $nome = trim((string) ($produtoLocal['nome'] ?? ''));
                $marcaBusca = trim((string) ($produtoLocal['marca'] ?? ''));
            }
        }

        if ($nome === '' && $codigo === '') {
            $this->jsonResponse(['error' => 'Informe nome ou codigo do produto'], 400);
        }

        $originalUrl = '';
        if ($codigo !== '' && strlen($codigo) >= 8) {
            $off = $this->fetchJson(sprintf('https://world.openfoodfacts.org/api/v2/product/%s.json', rawurlencode($codigo)), 5);
            if (is_array($off) && ($off['status'] ?? null) === 1 && is_array($off['product'] ?? null)) {
                $product = $off['product'];
                $originalUrl = trim((string) ($product['image_front_url'] ?? $product['image_url'] ?? ''));
            }
        }

        if ($originalUrl === '') {
            $query = trim($nome . ' ' . $marcaBusca . ' produto embalagem');
            $originalUrl = $this->fetchFirstWikimediaImage($query);
        }

        if ($originalUrl === '') {
            $fallback = $this->generateSvgDataUrl(trim($nome !== '' ? $nome : ($codigoInformado !== '' ? $codigoInformado : 'PRODUTO')));
            $this->jsonResponse(['imageUrl' => $fallback, 'originalUrl' => $fallback, 'source' => 'local-fallback']);
        }

        $this->jsonResponse([
            'imageUrl' => '/api/image-proxy?url=' . rawurlencode($originalUrl),
            'originalUrl' => $originalUrl,
            'source' => 'remote',
        ]);
    }

    private function handleProductImageOptions(): void
    {
        $state = $this->loadState();
        $relatedParam = strtolower(trim((string) ($_GET['related'] ?? '')));
        $semLimite = in_array($relatedParam, ['all', 'unlimited', 'sem-limite', 'sem_limite'], true);
        $relatedRaw = filter_var($relatedParam, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 120]]);
        $relatedCount = $semLimite ? null : ($relatedRaw !== false ? (int) $relatedRaw : 9);
        $total = $semLimite ? null : ($relatedCount + 1);

        $nome = trim((string) ($_GET['nome'] ?? ''));
        $codigoInformado = trim((string) ($_GET['codigo'] ?? ''));
        $codigo = $this->normalizeCpf($codigoInformado);
        $marca = trim((string) ($_GET['marca'] ?? ''));
        $sabor = trim((string) ($_GET['sabor'] ?? ''));
        $categoria = trim((string) ($_GET['categoria'] ?? ''));

        if ($codigoInformado !== '' && ($nome === '' || $marca === '')) {
            $produtoLocal = $this->findProductByAnyCode($state, $codigoInformado);
            if ($produtoLocal !== null) {
                if ($nome === '') {
                    $nome = trim((string) ($produtoLocal['nome'] ?? ''));
                }
                if ($marca === '') {
                    $marca = trim((string) ($produtoLocal['marca'] ?? ''));
                }
                if ($sabor === '') {
                    $sabor = trim((string) ($produtoLocal['sabor'] ?? ''));
                }
                if ($categoria === '') {
                    $categoria = trim((string) ($produtoLocal['categoria'] ?? ''));
                }
            }
        }

        if ($nome === '' && $codigo === '' && $marca === '' && $sabor === '' && $categoria === '') {
            $this->jsonResponse(['error' => 'Informe nome, marca, sabor, categoria ou codigo do produto'], 400);
        }

        $options = [];
        $seen = [];
        $addOption = function (string $url, string $source) use (&$options, &$seen): void {
            $clean = trim($url);
            if ($clean === '' || isset($seen[$clean])) {
                return;
            }
            $seen[$clean] = true;
            if (str_starts_with($clean, 'data:image/')) {
                $options[] = ['imageUrl' => $clean, 'originalUrl' => $clean, 'source' => $source];
                return;
            }
            $options[] = [
                'imageUrl' => '/api/image-proxy?url=' . rawurlencode($clean),
                'originalUrl' => $clean,
                'source' => $source,
            ];
        };

        if ($codigo !== '' && strlen($codigo) >= 8) {
            $off = $this->fetchJson(sprintf('https://world.openfoodfacts.org/api/v2/product/%s.json', rawurlencode($codigo)), 5);
            if (is_array($off) && ($off['status'] ?? null) === 1 && is_array($off['product'] ?? null)) {
                $product = $off['product'];
                $addOption((string) ($product['image_front_url'] ?? ''), 'openfoodfacts');
                $addOption((string) ($product['image_url'] ?? ''), 'openfoodfacts');
            }
        }

        $wikiQuery = trim(implode(' ', array_filter([$nome, $marca, $sabor, $categoria, 'produto embalagem'])));
        foreach ($this->fetchWikimediaImageOptions($wikiQuery, $total === null ? 18 : max(12, $total * 2)) as $url) {
            $addOption($url, 'wikimedia');
        }

        $baseLabel = trim(implode(' ', array_filter([$nome !== '' ? $nome : 'produto', $marca, $categoria])));
        $fallbackIndex = 0;
        $targetCount = $total ?? max(9, count($options));
        while (count($options) < $targetCount) {
            $suffix = $fallbackIndex === 0 ? '' : ' ' . (string) ($fallbackIndex + 1);
            $addOption($this->generateSvgDataUrl($baseLabel . $suffix), 'local-fallback');
            $fallbackIndex += 1;
            if ($fallbackIndex > 120) {
                break;
            }
        }

        $selected = $total === null ? $options : array_slice($options, 0, $total);
        $this->jsonResponse([
            'options' => $selected,
            'relatedRequested' => $semLimite ? 'all' : $relatedCount,
            'relatedFound' => max(0, count($selected) - 1),
        ]);
    }

    private function handleImageProxy(): void
    {
        $url = trim((string) ($_GET['url'] ?? ''));
        $validated = $this->validateExternalImageUrl($url);
        if (isset($validated['error'])) {
            $this->jsonResponse(['error' => $validated['error']], 400);
        }

        $response = $this->fetchBinary($validated['url'], 7);
        if ($response === null || $response['status'] < 200 || $response['status'] >= 300) {
            $this->jsonResponse(['error' => 'Nao foi possivel carregar a imagem'], 404);
        }

        $contentType = strtolower((string) ($response['contentType'] ?? ''));
        if (!str_starts_with($contentType, 'image/')) {
            $this->jsonResponse(['error' => 'URL nao retornou imagem valida'], 400);
        }

        header('Content-Type: ' . $contentType);
        header('Cache-Control: public, max-age=3600');
        echo $response['body'];
    }

    private function handleImageDownload(): void
    {
        $urlParam = trim((string) ($_GET['url'] ?? ''));
        if ($urlParam === '') {
            $this->jsonResponse(['error' => 'URL da imagem nao informada'], 400);
        }

        $finalUrl = $urlParam;
        if (str_starts_with($urlParam, '/api/image-proxy?')) {
            $parts = parse_url($urlParam);
            parse_str((string) ($parts['query'] ?? ''), $query);
            $innerUrl = trim((string) ($query['url'] ?? ''));
            if ($innerUrl === '') {
                $this->jsonResponse(['error' => 'URL da imagem invalida'], 400);
            }
            $finalUrl = $innerUrl;
        }

        $validated = $this->validateExternalImageUrl($finalUrl);
        if (isset($validated['error'])) {
            $this->jsonResponse(['error' => $validated['error']], 400);
        }

        $response = $this->fetchBinary($validated['url'], 7);
        if ($response === null || $response['status'] < 200 || $response['status'] >= 300) {
            $this->jsonResponse(['error' => 'Nao foi possivel baixar a imagem'], 404);
        }

        $contentType = strtolower((string) ($response['contentType'] ?? ''));
        if (!str_starts_with($contentType, 'image/')) {
            $this->jsonResponse(['error' => 'URL nao retornou uma imagem valida'], 400);
        }

        $extension = str_contains($contentType, 'png') ? 'png'
            : (str_contains($contentType, 'webp') ? 'webp'
                : (str_contains($contentType, 'gif') ? 'gif' : 'jpg'));

        header('Content-Type: ' . $contentType);
        header('Content-Disposition: attachment; filename="produto.' . $extension . '"');
        echo $response['body'];
    }

    private function handleAppTabRedirect(string $tab): void
    {
        $tab = trim($tab);
        $vendasTabs = ['estoque', 'categoriaProdutos', 'editarVenda', 'relatorioDiario'];
        $gestaoTabs = ['visao', 'relatorio', 'fiados', 'associado', 'usuarios', 'entrada'];

        if (in_array($tab, $vendasTabs, true)) {
            $this->redirect('/index.html?aba=' . rawurlencode($tab) . '&solo=1');
        }
        if (in_array($tab, $gestaoTabs, true)) {
            $this->redirect('/gestao.html?aba=' . rawurlencode($tab) . '&solo=1');
        }

        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Aba nao encontrada';
    }

    private function loadState(): array
    {
        if ($this->stateCache !== null) {
            return $this->stateCache;
        }

        $state = TOCA_DEFAULT_STATE;
        $fileData = $this->readFileState();
        if ($fileData !== null) {
            $state = $fileData;
        }

        $pdo = $this->getPdo();
        if ($pdo !== null) {
            $this->ensurePgTable($pdo);
            $stmt = $pdo->query('SELECT state FROM app_state WHERE id = 1 LIMIT 1');
            $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : false;
            if (is_array($row) && isset($row['state'])) {
                $decoded = json_decode((string) $row['state'], true);
                if (is_array($decoded)) {
                    $state = $decoded;
                }
            } elseif ($fileData !== null) {
                $this->persistState($state);
            }
        }

        $state = $this->ensureStateShape($state);
        $bootstrapChanged = $this->ensureBootstrapAdmin($state);
        $passwordsChanged = $this->ensureUserPasswordsHashed($state);
        if ($bootstrapChanged || $passwordsChanged) {
            $this->persistState($state);
        } else {
            $this->stateCache = $state;
        }

        return $this->stateCache;
    }

    private function persistState(array $state): void
    {
        $state = $this->ensureStateShape($state);
        $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            $this->jsonResponse(['error' => 'Falha ao serializar estado'], 500);
        }

        if (!is_dir(dirname($this->dbFile))) {
            mkdir(dirname($this->dbFile), 0777, true);
        }
        file_put_contents($this->dbFile, $json . PHP_EOL, LOCK_EX);

        $pdo = $this->getPdo();
        if ($pdo !== null) {
            $this->ensurePgTable($pdo);
            $stmt = $pdo->prepare(
                'INSERT INTO app_state (id, state, updated_at) VALUES (1, CAST(:state AS JSONB), NOW()) '
                . 'ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()'
            );
            $stmt->execute(['state' => $json]);
        }

        $this->stateCache = $state;
    }

    private function readFileState(): ?array
    {
        if (!is_file($this->dbFile)) {
            return is_file($this->rootDir . DIRECTORY_SEPARATOR . 'db.example.json')
                ? $this->readJsonFile($this->rootDir . DIRECTORY_SEPARATOR . 'db.example.json')
                : TOCA_DEFAULT_STATE;
        }

        return $this->readJsonFile($this->dbFile);
    }

    private function readJsonFile(string $path): ?array
    {
        $raw = @file_get_contents($path);
        if ($raw === false || trim($raw) === '') {
            return null;
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    private function ensureStateShape(array $state): array
    {
        $state = array_merge(TOCA_DEFAULT_STATE, $state);
        $state['products'] = is_array($state['products']) ? array_values(array_filter(array_map(
            fn ($product) => is_array($product) ? $this->normalizeStoredProduct($product, $product['id'] ?? null) : null,
            $state['products']
        ))) : [];
        $state['users'] = is_array($state['users']) ? array_values(array_filter($state['users'], 'is_array')) : [];
        $state['vendas'] = is_array($state['vendas']) ? array_values(array_filter($state['vendas'], 'is_array')) : [];
        $state['associados'] = is_array($state['associados']) ? array_values(array_filter($state['associados'], 'is_array')) : [];
        $counter = (int) ($state['vendaCounter'] ?? 1);
        $state['vendaCounter'] = $counter > 0 ? $counter : 1;
        $lastSaleId = $state['lastSaleId'] ?? null;
        $state['lastSaleId'] = ($lastSaleId === null || trim((string) $lastSaleId) === '') ? null : (string) $lastSaleId;
        return $state;
    }

    private function ensureBootstrapAdmin(array &$state): bool
    {
        if ($this->bootstrapAdminCpf === '' || $this->bootstrapAdminSenha === '' || $this->hasActiveAdminUser($state['users'])) {
            return false;
        }

        foreach ($state['users'] as &$user) {
            if ($this->normalizeCpf((string) ($user['cpf'] ?? '')) === $this->bootstrapAdminCpf) {
                $user['nome'] = $this->bootstrapAdminNome;
                $user['senha'] = $this->hashPassword($this->bootstrapAdminSenha);
                $user['perfil'] = 'admin';
                $user['ativo'] = true;
                unset($user);
                return true;
            }
        }
        unset($user);

        $state['users'][] = [
            'id' => $this->generateId(),
            'nome' => $this->bootstrapAdminNome,
            'cpf' => $this->bootstrapAdminCpf,
            'senha' => $this->hashPassword($this->bootstrapAdminSenha),
            'perfil' => 'admin',
            'ativo' => true,
            'criadoEm' => gmdate('c'),
        ];
        return true;
    }

    private function ensureUserPasswordsHashed(array &$state): bool
    {
        $changed = false;
        foreach ($state['users'] as &$user) {
            $senha = (string) ($user['senha'] ?? '');
            if ($senha !== '' && !$this->isPasswordHash($senha)) {
                $user['senha'] = $this->hashPassword($senha);
                $changed = true;
            }
        }
        unset($user);
        return $changed;
    }

    private function isPasswordHash(string $value): bool
    {
        return preg_match('/^\$2[aby]\$\d{2}\$/', $value) === 1;
    }

    private function verifyUserPassword(string $stored, string $input): array
    {
        if ($stored === '' || $input === '') {
            return ['match' => false, 'shouldUpgrade' => false];
        }

        if ($this->isPasswordHash($stored)) {
            if (str_starts_with($stored, '$2b$')) {
                $stored = '$2y$' . substr($stored, 4);
            }
            return ['match' => password_verify($input, $stored), 'shouldUpgrade' => false];
        }

        return ['match' => hash_equals($stored, $input), 'shouldUpgrade' => hash_equals($stored, $input)];
    }

    private function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => $this->passwordHashRounds]);
    }

    private function hasActiveAdminUser(array $users): bool
    {
        foreach ($users as $user) {
            if ($this->isAdminUser($user)) {
                return true;
            }
        }
        return false;
    }

    private function isAdminUser(array $user): bool
    {
        return (($user['perfil'] ?? 'operador') === 'admin') && (($user['ativo'] ?? true) !== false);
    }

    private function sanitizeIncomingState($payload): array
    {
        if (!is_array($payload)) {
            return ['error' => 'Estado invalido: payload deve ser um objeto'];
        }

        $produtos = $payload['produtos'] ?? null;
        $vendas = $payload['vendas'] ?? null;
        $associados = $payload['associados'] ?? null;
        if (!is_array($produtos) || !is_array($vendas) || !is_array($associados)) {
            return ['error' => 'Estado invalido: produtos, vendas e associados devem ser listas'];
        }

        $products = [];
        foreach ($produtos as $index => $product) {
            if (!is_array($product)) {
                return ['error' => 'Estado invalido: produto ' . ($index + 1) . ' esta incompleto ou possui valores invalidos'];
            }
            $normalized = $this->normalizeStoredProduct($product, 'produto-' . ($index + 1));
            if ($normalized === null) {
                return ['error' => 'Estado invalido: produto ' . ($index + 1) . ' esta incompleto ou possui valores invalidos'];
            }
            $products[] = $normalized;
        }

        foreach (['vendas' => $vendas, 'associados' => $associados] as $key => $items) {
            foreach ($items as $item) {
                if (!is_array($item)) {
                    return ['error' => 'Estado invalido: ' . $key . ' devem conter apenas objetos validos'];
                }
            }
        }

        $vendaCounter = (int) ($payload['vendaCounter'] ?? 1);
        $lastSaleId = $payload['lastSaleId'] ?? null;
        return [
            'state' => [
                'products' => $products,
                'vendas' => array_values($vendas),
                'associados' => array_values($associados),
                'vendaCounter' => $vendaCounter > 0 ? $vendaCounter : 1,
                'lastSaleId' => ($lastSaleId === null || trim((string) $lastSaleId) === '') ? null : (string) $lastSaleId,
            ],
        ];
    }

    private function normalizeStoredProduct(array $product, $fallbackId): ?array
    {
        $nome = trim((string) ($product['nome'] ?? $product['name'] ?? ''));
        $preco = $this->normalizePositiveNumber($product['preco'] ?? $product['price'] ?? null);
        $estoque = $this->normalizeNonNegativeInteger($product['estoque'] ?? $product['stock'] ?? null);
        if ($nome === '' || $preco === null || $estoque === null) {
            return null;
        }

        $normalized = [
            'id' => $product['id'] ?? $fallbackId ?? $this->generateId(),
            'nome' => $nome,
            'preco' => $preco,
            'estoque' => $estoque,
        ];

        foreach (['codigoBarras', 'codigo', 'sku', 'marca', 'imagemUrl', 'categoria', 'sabor'] as $field) {
            $value = trim((string) ($product[$field] ?? ''));
            if ($value !== '') {
                $normalized[$field] = $value;
            }
        }

        $valorCasco = $this->normalizePositiveNumber($product['valorCasco'] ?? null);
        if ($valorCasco !== null) {
            $normalized['valorCasco'] = $valorCasco;
        }

        return $normalized;
    }

    private function normalizeProductPayload($body, ?array $currentProduct): array
    {
        $source = is_array($body) ? $body : [];
        $nome = trim((string) ($source['nome'] ?? $source['name'] ?? ''));
        $preco = $this->normalizePositiveNumber($source['preco'] ?? $source['price'] ?? null);
        $estoque = $this->normalizeNonNegativeInteger($source['estoque'] ?? $source['stock'] ?? null);
        if ($nome === '' || $preco === null || $estoque === null) {
            return ['error' => 'Produto invalido: informe nome, preco e estoque validos'];
        }

        $product = [
            'id' => $currentProduct['id'] ?? ($source['id'] ?? $this->generateId()),
            'nome' => $nome,
            'preco' => $preco,
            'estoque' => $estoque,
        ];

        foreach (['codigoBarras', 'categoria', 'marca', 'imagemUrl', 'codigo', 'sku', 'sabor'] as $field) {
            $value = trim((string) ($source[$field] ?? ''));
            if ($value !== '') {
                $product[$field] = $value;
            }
        }

        $valorCasco = $this->normalizePositiveNumber($source['valorCasco'] ?? null);
        if ($valorCasco !== null) {
            $product['valorCasco'] = $valorCasco;
        }

        return $product;
    }

    private function normalizePositiveNumber($value): ?float
    {
        if (!is_numeric($value)) {
            return null;
        }
        $number = (float) $value;
        return $number >= 0 ? $number : null;
    }

    private function normalizeNonNegativeInteger($value): ?int
    {
        if (!is_numeric($value)) {
            return null;
        }
        $number = (int) $value;
        return $number >= 0 ? $number : null;
    }

    private function requireLogin(string $path): void
    {
        if (!($_SESSION['loggedIn'] ?? false)) {
            if (str_starts_with($path, '/api/')) {
                $this->jsonResponse(['error' => 'Sessao expirada. Faca login novamente.'], 401);
            }
            $this->redirect('/login.html');
        }

        if (!isset($_SESSION['user']) || !is_array($_SESSION['user'])) {
            $state = $this->loadState();
            $fallback = null;
            foreach ($state['users'] as $user) {
                if ($this->isAdminUser($user)) {
                    $fallback = $user;
                    break;
                }
                if ((($user['ativo'] ?? true) !== false) && $fallback === null) {
                    $fallback = $user;
                }
            }

            if ($fallback === null) {
                $_SESSION = [];
                session_destroy();
                if (str_starts_with($path, '/api/')) {
                    $this->jsonResponse(['error' => 'Sessao expirada. Faca login novamente.'], 401);
                }
                $this->redirect('/login.html');
            }

            $_SESSION['user'] = [
                'id' => $fallback['id'],
                'nome' => $fallback['nome'],
                'cpf' => $fallback['cpf'],
                'perfil' => $fallback['perfil'] ?? 'operador',
            ];
        }
    }

    private function requireAdmin(): void
    {
        $state = $this->loadState();
        if (!$this->hasActiveAdminUser($state['users'])) {
            $this->jsonResponse(['error' => 'Nenhum administrador ativo. Configure BOOTSTRAP_ADMIN_* para recuperar o acesso.'], 503);
        }
        if ((string) ($_SESSION['user']['perfil'] ?? 'operador') !== 'admin') {
            $this->jsonResponse(['error' => 'Acesso permitido apenas para administrador'], 403);
        }
    }

    private function ensureSessionCsrfToken(): string
    {
        if (!isset($_SESSION['csrfToken']) || !is_string($_SESSION['csrfToken']) || $_SESSION['csrfToken'] === '') {
            $_SESSION['csrfToken'] = bin2hex(random_bytes(24));
        }
        return $_SESSION['csrfToken'];
    }

    private function requireCsrf(): void
    {
        $sessionToken = $this->ensureSessionCsrfToken();
        $requestToken = trim((string) ($this->getHeader('X-CSRF-Token')
            ?? ($_GET['csrfToken'] ?? null)
            ?? ($this->readFlexibleBody()['csrfToken'] ?? null)
            ?? ''));

        if ($requestToken === '' || !hash_equals($sessionToken, $requestToken)) {
            $this->jsonResponse(['error' => 'Falha de validacao da sessao. Atualize a pagina e tente novamente.'], 403);
        }
    }

    private function readJsonBody(): array
    {
        $body = $this->readFlexibleBody();
        return is_array($body) ? $body : [];
    }

    private function readFlexibleBody()
    {
        static $cachedBody = null;
        static $loaded = false;
        if ($loaded) {
            return $cachedBody;
        }

        $loaded = true;
        $contentType = strtolower((string) ($this->getHeader('Content-Type') ?? ''));
        $raw = file_get_contents('php://input');

        if (str_contains($contentType, 'application/json')) {
            $decoded = json_decode((string) $raw, true);
            $cachedBody = is_array($decoded) ? $decoded : [];
            return $cachedBody;
        }

        if (str_contains($contentType, 'application/x-www-form-urlencoded')) {
            parse_str((string) $raw, $form);
            $cachedBody = is_array($form) ? $form : $_POST;
            return $cachedBody;
        }

        $trimmed = trim((string) $raw);
        if ($trimmed !== '' && ($trimmed[0] ?? '') === '{') {
            $decoded = json_decode($trimmed, true);
            if (is_array($decoded)) {
                $cachedBody = $decoded;
                return $cachedBody;
            }
        }

        $cachedBody = $_POST;
        return $cachedBody;
    }

    private function destroySession(): void
    {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], (bool) $params['secure'], (bool) $params['httponly']);
        }
        session_destroy();
    }

    private function expectsJson(): bool
    {
        $accept = strtolower((string) ($this->getHeader('Accept') ?? ''));
        $requestedWith = strtolower((string) ($this->getHeader('X-Requested-With') ?? ''));
        return str_contains($accept, 'application/json') || $requestedWith === 'fetch';
    }

    private function serveProtectedPage(string $path): bool
    {
        $protected = ['/', '/principal.html', '/index.html', '/gestao.html'];
        if (!in_array($path, $protected, true)) {
            return false;
        }

        $this->requireLogin($path);
        $file = $path === '/' ? $this->publicDir . DIRECTORY_SEPARATOR . 'principal.html' : $this->publicDir . str_replace('/', DIRECTORY_SEPARATOR, $path);
        $this->sendFile($file);
        return true;
    }

    private function servePublicAsset(string $path): bool
    {
        if ($path === '/favicon.ico') {
            return false;
        }

        $relative = ltrim($path, '/');
        if ($relative === '') {
            return false;
        }

        $target = realpath($this->publicDir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relative));
        if ($target === false || !str_starts_with($target, realpath($this->publicDir) ?: $this->publicDir) || !is_file($target)) {
            return false;
        }

        $this->sendFile($target);
        return true;
    }

    private function sendFile(string $file): void
    {
        if (!is_file($file)) {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Arquivo nao encontrado';
            return;
        }

        $mime = mime_content_type($file) ?: 'application/octet-stream';
        if (str_ends_with($file, '.html')) {
            header('Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate');
            header('Pragma: no-cache');
            header('Expires: 0');
            header('Surrogate-Control: no-store');
        }

        header('Content-Type: ' . $mime);
        readfile($file);
    }

    private function createBackup(string $reason): array
    {
        $fileName = sprintf('backup-%s-%s.json', gmdate('Ymd-His'), preg_replace('/[^a-zA-Z0-9_-]/', '_', $reason));
        $fullPath = $this->backupDir . DIRECTORY_SEPARATOR . $fileName;
        $snapshot = [
            'createdAt' => gmdate('c'),
            'reason' => $reason,
            'source' => 'php-backup',
            'state' => $this->loadState(),
        ];
        file_put_contents($fullPath, json_encode($snapshot, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL, LOCK_EX);
        return ['fileName' => $fileName, 'createdAt' => $snapshot['createdAt']];
    }

    private function listBackupFiles(): array
    {
        if (!is_dir($this->backupDir)) {
            return [];
        }

        $items = [];
        $entries = scandir($this->backupDir) ?: [];
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..' || !str_ends_with($entry, '.json')) {
                continue;
            }
            $fullPath = $this->backupDir . DIRECTORY_SEPARATOR . $entry;
            if (!is_file($fullPath)) {
                continue;
            }

            $items[] = [
                'name' => $entry,
                'fullPath' => $fullPath,
                'size' => filesize($fullPath) ?: 0,
                'createdAt' => gmdate('c', filectime($fullPath) ?: time()),
                'modifiedAt' => gmdate('c', filemtime($fullPath) ?: time()),
                'sortTime' => filemtime($fullPath) ?: 0,
            ];
        }

        usort($items, static fn (array $a, array $b): int => $b['sortTime'] <=> $a['sortTime']);
        return $items;
    }

    private function sendJsonDownload(string $path, string $name): void
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $name . '"');
        readfile($path);
    }

    private function findProductByAnyCode(array $state, string $codigoInformado): ?array
    {
        $codigoOriginal = trim($codigoInformado);
        if ($codigoOriginal === '') {
            return null;
        }

        $codigoNormalizado = $this->normalizeGenericCode($codigoOriginal);
        $codigoDigitos = $this->normalizeCpf($codigoOriginal);
        if ($codigoNormalizado === '' && $codigoDigitos === '') {
            return null;
        }

        foreach ($state['products'] as $product) {
            foreach (['codigoBarras', 'codigo', 'sku', 'id'] as $field) {
                $candidate = trim((string) ($product[$field] ?? ''));
                if ($candidate === '') {
                    continue;
                }
                if ($codigoNormalizado !== '' && $this->normalizeGenericCode($candidate) === $codigoNormalizado) {
                    return $product;
                }
                if ($codigoDigitos !== '' && $this->normalizeCpf($candidate) === $codigoDigitos) {
                    return $product;
                }
            }
        }

        return null;
    }

    private function normalizeCpf(string $cpf): string
    {
        return preg_replace('/\D+/', '', $cpf) ?? '';
    }

    private function normalizeGenericCode(string $value): string
    {
        return preg_replace('/[^a-z0-9]+/', '', strtolower($value)) ?? '';
    }

    private function validateExternalImageUrl(string $rawUrl): array
    {
        $rawUrl = trim($rawUrl);
        if ($rawUrl === '') {
            return ['error' => 'URL da imagem nao informada'];
        }

        $parts = parse_url($rawUrl);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return ['error' => 'URL da imagem invalida'];
        }

        $scheme = strtolower((string) $parts['scheme']);
        if (!in_array($scheme, ['http', 'https'], true)) {
            return ['error' => 'Protocolo de URL nao permitido'];
        }

        $host = strtolower(trim((string) $parts['host']));
        if ($host === '' || $host === 'localhost' || str_ends_with($host, '.local') || $this->isBlockedIpAddress($host)) {
            return ['error' => 'Host de URL nao permitido'];
        }

        return ['url' => $rawUrl];
    }

    private function isBlockedIpAddress(string $hostname): bool
    {
        if (filter_var($hostname, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $parts = array_map('intval', explode('.', $hostname));
            return $parts[0] === 10
                || $parts[0] === 127
                || $parts[0] === 0
                || ($parts[0] === 169 && $parts[1] === 254)
                || ($parts[0] === 172 && $parts[1] >= 16 && $parts[1] <= 31)
                || ($parts[0] === 192 && $parts[1] === 168);
        }

        if (filter_var($hostname, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            $normalized = strtolower($hostname);
            return $normalized === '::1'
                || str_starts_with($normalized, 'fc')
                || str_starts_with($normalized, 'fd')
                || str_starts_with($normalized, 'fe80');
        }

        return false;
    }

    private function fetchFirstWikimediaImage(string $query): string
    {
        $items = $this->fetchWikimediaImageOptions($query, 5);
        return $items[0] ?? '';
    }

    private function fetchWikimediaImageOptions(string $query, int $limit): array
    {
        $query = trim($query);
        if ($query === '') {
            return [];
        }

        $url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch='
            . rawurlencode($query)
            . '&gsrlimit=' . max(1, min($limit, 50))
            . '&prop=imageinfo&iiprop=url|mime&format=json';

        $data = $this->fetchJson($url, 5);
        if (!is_array($data) || !isset($data['query']['pages']) || !is_array($data['query']['pages'])) {
            return [];
        }

        $urls = [];
        foreach ($data['query']['pages'] as $page) {
            $info = is_array($page['imageinfo'] ?? null) ? ($page['imageinfo'][0] ?? null) : null;
            $mime = strtolower((string) ($info['mime'] ?? ''));
            $imageUrl = trim((string) ($info['url'] ?? ''));
            if ($imageUrl !== '' && str_starts_with($mime, 'image/')) {
                $urls[] = $imageUrl;
            }
        }

        return array_values(array_unique($urls));
    }

    private function generateSvgDataUrl(string $text): string
    {
        $base = strtoupper(trim($text)) ?: 'PRODUTO';
        $base = substr($base, 0, 28);
        $hash = 0;
        foreach (str_split($base) as $char) {
            $hash = (($hash << 5) - $hash + ord($char)) & 0x7fffffff;
        }
        $hue = abs($hash) % 360;
        $bg = sprintf('hsl(%d 62%% 42%%)', $hue);
        $bg2 = sprintf('hsl(%d 65%% 30%%)', ($hue + 40) % 360);
        $lines = array_values(array_filter(str_split($base, 14), static fn (string $line): bool => trim($line) !== ''));
        $line1 = htmlspecialchars($lines[0] ?? 'PRODUTO', ENT_QUOTES, 'UTF-8');
        $line2 = htmlspecialchars($lines[1] ?? '', ENT_QUOTES, 'UTF-8');

        $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">'
            . '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="' . $bg . '" /><stop offset="100%" stop-color="' . $bg2 . '" /></linearGradient></defs>'
            . '<rect width="768" height="768" fill="url(#g)"/>'
            . '<rect x="64" y="64" width="640" height="640" rx="38" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.24)"/>'
            . '<text x="384" y="300" text-anchor="middle" font-size="110" font-family="Arial" fill="white">PKG</text>'
            . '<text x="384" y="430" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">' . $line1 . '</text>'
            . '<text x="384" y="490" text-anchor="middle" font-size="46" font-family="Arial" font-weight="700" fill="white">' . $line2 . '</text>'
            . '</svg>';

        return 'data:image/svg+xml;utf8,' . rawurlencode($svg);
    }

    private function fetchJson(string $url, int $timeoutSeconds): ?array
    {
        $response = $this->fetchBinary($url, $timeoutSeconds, ['Accept: application/json']);
        if ($response === null || $response['status'] < 200 || $response['status'] >= 300) {
            return null;
        }
        $decoded = json_decode($response['body'], true);
        return is_array($decoded) ? $decoded : null;
    }

    private function fetchBinary(string $url, int $timeoutSeconds, array $headers = []): ?array
    {
        if (function_exists('curl_init')) {
            $curl = curl_init($url);
            curl_setopt_array($curl, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 3,
                CURLOPT_CONNECTTIMEOUT => max(2, $timeoutSeconds),
                CURLOPT_TIMEOUT => max(2, $timeoutSeconds),
                CURLOPT_HTTPHEADER => array_merge(['User-Agent: Mozilla/5.0 TocaPHP/1.0'], $headers),
                CURLOPT_HEADER => true,
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $raw = curl_exec($curl);
            if ($raw === false) {
                curl_close($curl);
                return null;
            }
            $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            $headerSize = (int) curl_getinfo($curl, CURLINFO_HEADER_SIZE);
            $contentType = (string) curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
            $body = substr($raw, $headerSize);
            curl_close($curl);
            return ['status' => $status, 'contentType' => $contentType, 'body' => $body];
        }

        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => implode("\r\n", array_merge(['User-Agent: Mozilla/5.0 TocaPHP/1.0'], $headers)),
                'timeout' => max(2, $timeoutSeconds),
                'ignore_errors' => true,
            ],
        ]);

        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            return null;
        }

        $status = 200;
        $contentType = '';
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match) === 1) {
                $status = (int) $match[1];
            }
            if (stripos($line, 'Content-Type:') === 0) {
                $contentType = trim(substr($line, 13));
            }
        }

        return ['status' => $status, 'contentType' => $contentType, 'body' => $body];
    }

    private function getHeader(string $name): ?string
    {
        $target = strtolower($name);
        foreach ($this->allHeaders() as $headerName => $value) {
            if (strtolower($headerName) === $target) {
                return is_array($value) ? implode(', ', $value) : (string) $value;
            }
        }
        return null;
    }

    private function allHeaders(): array
    {
        if (function_exists('getallheaders')) {
            $headers = getallheaders();
            if (is_array($headers)) {
                return $headers;
            }
        }

        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($key, 5)))));
                $headers[$name] = $value;
            }
        }

        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
        }
        return $headers;
    }

    private function getPdo(): ?PDO
    {
        if ($this->databaseUrl === '' || !extension_loaded('pdo_pgsql')) {
            return null;
        }
        if ($this->pdo !== null) {
            return $this->pdo;
        }

        $parts = parse_url($this->databaseUrl);
        if (!is_array($parts)) {
            return null;
        }

        $host = $parts['host'] ?? '';
        $port = $parts['port'] ?? 5432;
        $db = ltrim((string) ($parts['path'] ?? ''), '/');
        $user = $parts['user'] ?? '';
        $pass = $parts['pass'] ?? '';
        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s;sslmode=require', $host, $port, $db);

        try {
            $this->pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (Throwable $error) {
            $this->pdo = null;
        }

        return $this->pdo;
    }

    private function ensurePgTable(PDO $pdo): void
    {
        $pdo->exec('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    }

    private function resolveWritableDbFile(): string
    {
        $requested = trim((string) getenv('DB_FILE'));
        $candidates = array_filter([
            $requested,
            $this->rootDir . DIRECTORY_SEPARATOR . 'db.json',
            sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'toca-db.json',
        ]);

        foreach ($candidates as $candidate) {
            $dir = dirname($candidate);
            if (!is_dir($dir)) {
                @mkdir($dir, 0777, true);
            }
            if (is_dir($dir) && (is_writable($dir) || (!file_exists($candidate) && is_writable($dir)) || is_writable($candidate))) {
                return $candidate;
            }
        }

        return $this->rootDir . DIRECTORY_SEPARATOR . 'db.json';
    }

    private function resolveWritableBackupDir(): string
    {
        $requested = trim((string) getenv('BACKUP_DIR'));
        $candidates = array_filter([
            $requested,
            $this->rootDir . DIRECTORY_SEPARATOR . 'backups',
            sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'toca-backups',
        ]);

        foreach ($candidates as $candidate) {
            if (!is_dir($candidate)) {
                @mkdir($candidate, 0777, true);
            }
            if (is_dir($candidate) && is_writable($candidate)) {
                return $candidate;
            }
        }

        return $this->rootDir . DIRECTORY_SEPARATOR . 'backups';
    }

    private function loadPackageVersion(): string
    {
        $packagePath = $this->rootDir . DIRECTORY_SEPARATOR . 'package.json';
        if (!is_file($packagePath)) {
            return '1.0.0';
        }
        $decoded = $this->readJsonFile($packagePath);
        return is_array($decoded) && isset($decoded['version']) ? (string) $decoded['version'] : '1.0.0';
    }

    private function jsonResponse(array $payload, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    private function redirect(string $path): void
    {
        header('Location: ' . $path, true, 302);
        exit;
    }

    private function findIndexById(array $items, string $id): int
    {
        foreach ($items as $index => $item) {
            if ((string) ($item['id'] ?? '') === $id) {
                return $index;
            }
        }
        return -1;
    }

    private function generateId(): string
    {
        $hex = bin2hex(random_bytes(16));
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }
}

(new TocaApp())->run();