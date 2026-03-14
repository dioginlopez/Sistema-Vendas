(function () {
  function respostaIndicaSessaoExpirada(resposta, contentType) {
    if (!resposta) return false;
    if (resposta.status === 401) return true;

    const finalType = String(contentType || '').toLowerCase();
    const urlFinal = String(resposta.url || '').toLowerCase();
    const foiParaLogin = urlFinal.includes('/login.html');
    if (resposta.redirected && foiParaLogin) return true;
    if (resposta.status === 200 && !finalType.includes('application/json') && foiParaLogin) return true;
    return false;
  }

  function respostaIndicaFalhaCsrf(resposta) {
    return Boolean(resposta) && resposta.status === 403;
  }

  function criarErroSessaoExpirada() {
    const erro = new Error('Sessão expirada. Faça login novamente.');
    erro.codigo = 'SESSION_EXPIRED';
    return erro;
  }

  function erroEhSessaoExpirada(erro) {
    return Boolean(erro && erro.codigo === 'SESSION_EXPIRED');
  }

  function montarUrlComCsrf(url, token) {
    const csrfToken = String(token || '').trim();
    if (!csrfToken) return url;

    const finalUrl = new URL(url, window.location.origin);
    finalUrl.searchParams.set('csrfToken', csrfToken);
    return finalUrl.origin === window.location.origin
      ? `${finalUrl.pathname}${finalUrl.search}`
      : finalUrl.toString();
  }

  function installCsrfFetch(getToken) {
    if (window.__tocaFetchInstalled) {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const options = init ? { ...init } : {};
      const method = String(options.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : String(input && input.url ? input.url : '');
      const sameOrigin = !url || url.startsWith('/') || url.startsWith(window.location.origin);
      const csrfToken = typeof getToken === 'function' ? String(getToken() || '').trim() : '';

      if (sameOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
        const headers = new Headers(options.headers || (input && typeof input === 'object' ? input.headers : undefined));
        headers.set('X-CSRF-Token', csrfToken);
        options.headers = headers;
      }

      return originalFetch(input, options);
    };

    window.__tocaFetchInstalled = true;
  }

  window.TocaSession = {
    respostaIndicaSessaoExpirada,
    respostaIndicaFalhaCsrf,
    criarErroSessaoExpirada,
    erroEhSessaoExpirada,
    montarUrlComCsrf,
    installCsrfFetch,
  };
})();