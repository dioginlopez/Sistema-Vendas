(function () {
  const BROWSER_SESSION_STORAGE_KEY = 'tocaBrowserSessionKey';

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

  function getBrowserSessionKey() {
    try {
      return String(window.sessionStorage.getItem(BROWSER_SESSION_STORAGE_KEY) || '').trim();
    } catch (error) {
      return '';
    }
  }

  function setBrowserSessionKey(value) {
    const browserSessionKey = String(value || '').trim();
    try {
      if (!browserSessionKey) {
        window.sessionStorage.removeItem(BROWSER_SESSION_STORAGE_KEY);
        return '';
      }
      window.sessionStorage.setItem(BROWSER_SESSION_STORAGE_KEY, browserSessionKey);
      return browserSessionKey;
    } catch (error) {
      return browserSessionKey;
    }
  }

  function clearBrowserSessionKey() {
    try {
      window.sessionStorage.removeItem(BROWSER_SESSION_STORAGE_KEY);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function hasBrowserSessionKey() {
    return getBrowserSessionKey() !== '';
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
      const browserSessionKey = getBrowserSessionKey();
      const headers = new Headers(options.headers || (input && typeof input === 'object' ? input.headers : undefined));

      if (sameOrigin && browserSessionKey) {
        headers.set('X-Browser-Session', browserSessionKey);
      }

      if (sameOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
      }

      options.headers = headers;

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
    getBrowserSessionKey,
    setBrowserSessionKey,
    clearBrowserSessionKey,
    hasBrowserSessionKey,
    installCsrfFetch,
  };
})();