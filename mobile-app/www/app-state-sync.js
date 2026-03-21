(function () {
  function create(config) {
    let pendingTimeout = null;

    function clearPendingTimeout() {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
      }
    }

    async function save(options) {
      if (!config.isEnabled()) return false;

      const opts = options || {};
      const forcar = Boolean(opts.forcar);
      const usarKeepAlive = Boolean(opts.usarKeepAlive);
      const estado = config.getState();
      const serializado = JSON.stringify(estado);

      if (!forcar && serializado === config.getLastSerialized()) {
        return true;
      }

      try {
        const resposta = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: serializado,
          keepalive: usarKeepAlive,
        });

        if (!resposta.ok) {
          const contentType = String(resposta.headers.get('content-type') || '').toLowerCase();
          if (config.isSessionExpiredResponse(resposta, contentType)) {
            config.onAuthExpired();
            return false;
          }
          if (config.isCsrfFailureResponse(resposta)) {
            config.onCsrfFailure();
            return false;
          }
          return false;
        }

        config.setLastSerialized(serializado);
        config.onSaveSuccess();
        return true;
      } catch (error) {
        return false;
      }
    }

    function schedule() {
      if (!config.isEnabled()) return;
      clearPendingTimeout();
      pendingTimeout = setTimeout(() => {
        save();
      }, 350);
    }

    function flushOnExit() {
      if (!config.isEnabled()) return;
      clearPendingTimeout();

      const serializado = JSON.stringify(config.getState());
      if (serializado === config.getLastSerialized()) return;

      if (navigator.sendBeacon) {
        try {
          const payload = new Blob([serializado], { type: 'application/json' });
          const sent = navigator.sendBeacon(config.getFlushUrl(), payload);
          if (sent) {
            config.setLastSerialized(serializado);
            return;
          }
        } catch (error) {
          // Fallback below.
        }
      }

      save({ forcar: true, usarKeepAlive: true });
    }

    return {
      save,
      schedule,
      flushOnExit,
      clearPendingTimeout,
    };
  }

  window.TocaStateSync = { create };
})();
