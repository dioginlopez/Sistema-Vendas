(function () {
  function createDefaultProducts() {
    return [
      { id: 1, nome: 'Leite Integral', preco: 4.50, estoque: 50 },
      { id: 2, nome: 'Pão Francês', preco: 0.80, estoque: 100 },
      { id: 3, nome: 'Arroz 5kg', preco: 25.00, estoque: 30 },
      { id: 4, nome: 'Feijão 1kg', preco: 7.50, estoque: 40 },
      { id: 5, nome: 'Açúcar 1kg', preco: 4.00, estoque: 60 },
      { id: 6, nome: 'Sal 1kg', preco: 2.00, estoque: 80 },
    ];
  }

  function atualizarContadorComVendas(vendas, vendaCounter) {
    const lista = Array.isArray(vendas) ? vendas : [];
    const atual = Number.isFinite(Number(vendaCounter)) ? Number(vendaCounter) : 1;
    if (!lista.length) return atual;

    const maxId = lista.reduce((max, venda) => (venda && venda.id > max ? venda.id : max), 0);
    return Math.max(atual, maxId + 1);
  }

  function atualizarIndicadorUltimaVenda() {
    const info = document.getElementById('lastSaleInfo');
    if (!info) return;

    const lastId = localStorage.getItem('lastSaleId');
    info.textContent = lastId ? `Última venda: #${lastId}` : '';
  }

  function instalarPreviewImagemProduto(atualizarPreviewImagemProduto) {
    const campoUrlImagemProduto = document.getElementById('produtoImagemUrl');
    if (!campoUrlImagemProduto || typeof atualizarPreviewImagemProduto !== 'function') {
      return;
    }

    campoUrlImagemProduto.addEventListener('input', () => {
      const url = campoUrlImagemProduto.value.trim();
      atualizarPreviewImagemProduto(url, url ? 'Imagem definida manualmente' : '');
    });
  }

  async function bootAuthenticatedPage(options) {
    const opts = options || {};

    if (window.TocaSession && typeof window.TocaSession.ensureBrowserSessionKey === 'function') {
      window.TocaSession.ensureBrowserSessionKey();
    }

    window.addEventListener('offline', () => {
      if (typeof opts.onOffline === 'function') {
        opts.onOffline();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && typeof opts.onBeforeLeave === 'function') {
        opts.onBeforeLeave();
      }
    });

    window.addEventListener('pagehide', () => {
      if (typeof opts.onBeforeLeave === 'function') {
        opts.onBeforeLeave();
      }
    });

    const sessaoValida = await opts.loadProfile();
    if (sessaoValida === false) {
      if (typeof opts.onSessionInvalid === 'function') {
        opts.onSessionInvalid();
      }
      return false;
    }

    await opts.loadState();

    if (typeof opts.onAfterLoadState === 'function') {
      await opts.onAfterLoadState();
    }

    if (typeof opts.enableSync === 'function') {
      opts.enableSync();
    }

    if (typeof opts.startSyncInterval === 'function') {
      opts.startSyncInterval();
    }

    if (typeof opts.onAfterBoot === 'function') {
      await opts.onAfterBoot();
    }

    return true;
  }

  window.TocaPageBootstrap = {
    createDefaultProducts,
    atualizarContadorComVendas,
    atualizarIndicadorUltimaVenda,
    instalarPreviewImagemProduto,
    bootAuthenticatedPage,
  };
})();
