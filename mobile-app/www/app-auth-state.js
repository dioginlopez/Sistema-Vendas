(function () {
  function validarEstadoPayload(dados) {
    return Boolean(dados)
      && Array.isArray(dados.produtos)
      && Array.isArray(dados.vendas)
      && Array.isArray(dados.associados);
  }

  function normalizarLastSaleId(lastSaleId) {
    if (lastSaleId === null || lastSaleId === undefined || String(lastSaleId) === '') {
      return null;
    }
    return String(lastSaleId);
  }

  function montarEstadoMesclado(dados, vendasLocal) {
    const idsServidor = new Set(dados.vendas.map((v) => v.id));
    const vendasExtras = vendasLocal.filter((v) => !idsServidor.has(v.id));
    const vendas = vendasExtras.length > 0
      ? [...vendasExtras, ...dados.vendas].sort((a, b) => b.id - a.id)
      : dados.vendas;

    let vendaCounter = parseInt(dados.vendaCounter, 10) || 1;
    if (vendas.length > 0) {
      const maxId = vendas.reduce((max, venda) => (venda.id > max ? venda.id : max), 0);
      if (maxId >= vendaCounter) vendaCounter = maxId + 1;
    }

    return {
      produtos: dados.produtos,
      vendas,
      associados: dados.associados,
      vendaCounter,
      lastSaleId: normalizarLastSaleId(dados.lastSaleId),
      hadLocalExtras: vendasExtras.length > 0,
    };
  }

  async function carregarPerfil(options) {
    const opts = options || {};
    try {
      const resposta = await fetch('/api/me', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });

      const contentType = String(resposta.headers.get('content-type') || '').toLowerCase();
      if (opts.respostaIndicaSessaoExpirada && opts.respostaIndicaSessaoExpirada(resposta, contentType)) {
        return { status: false, usuario: null, perfil: 'operador', csrfToken: '' };
      }

      if (!resposta.ok || !contentType.includes('application/json')) {
        return { status: null, usuario: null, perfil: 'operador', csrfToken: '' };
      }

      const dados = await resposta.json();
      const usuario = dados && dados.user ? dados.user : null;
      const perfil = usuario && usuario.perfil ? String(usuario.perfil).toLowerCase() : 'operador';
      const csrfToken = String(dados && dados.csrfToken ? dados.csrfToken : '').trim();
      return { status: Boolean(usuario), usuario, perfil, csrfToken };
    } catch (error) {
      return { status: null, usuario: null, perfil: 'operador', csrfToken: '' };
    }
  }

  async function carregarEstado(options) {
    const opts = options || {};
    try {
      const resposta = await fetch('/api/state', { headers: { Accept: 'application/json' } });
      if (!resposta.ok) {
        return { ok: false };
      }

      const dados = await resposta.json();
      if (!validarEstadoPayload(dados)) {
        return { ok: false };
      }

      const vendasLocal = Array.isArray(opts.vendasLocal) ? opts.vendasLocal : [];
      const estado = montarEstadoMesclado(dados, vendasLocal);
      return { ok: true, estado };
    } catch (error) {
      return { ok: false };
    }
  }

  window.TocaAuthState = {
    carregarPerfil,
    carregarEstado,
  };
})();
