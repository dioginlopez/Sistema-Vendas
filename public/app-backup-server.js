(function () {
  function baixarBlobComoArquivo(blob, nomeArquivo) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = nomeArquivo;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  async function criarBackupServidor(deps) {
    const d = deps || {};
    if (!d.isAdmin()) return d.blockAdmin();

    try {
      const resposta = await fetch('/api/backups', { method: 'POST' });
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) {
        throw new Error(dados.error || 'Falha ao criar backup no servidor');
      }
      d.alert(`Backup criado no servidor: ${dados.fileName || 'ok'}`, 'sucesso');
    } catch (error) {
      d.alert(error.message || 'Erro ao criar backup no servidor', 'erro');
    }
  }

  async function baixarUltimoBackupServidor(deps) {
    const d = deps || {};
    if (!d.isAdmin()) return d.blockAdmin();

    try {
      const resposta = await fetch('/api/backups/latest/download');
      if (!resposta.ok) {
        const dadosErro = await resposta.json().catch(() => ({}));
        throw new Error(dadosErro.error || 'Falha ao baixar ultimo backup');
      }

      const blob = await resposta.blob();
      const cd = resposta.headers.get('content-disposition') || '';
      const match = cd.match(/filename="?([^";]+)"?/i);
      const nomeArquivo = match ? match[1] : `backup_servidor_${new Date().toISOString().slice(0, 10)}.json`;
      baixarBlobComoArquivo(blob, nomeArquivo);
      d.alert('Backup mais recente baixado com sucesso', 'sucesso');
    } catch (error) {
      d.alert(error.message || 'Erro ao baixar backup do servidor', 'erro');
    }
  }

  async function baixarBackupServidorEspecifico(deps) {
    const d = deps || {};
    if (!d.isAdmin()) return d.blockAdmin();

    try {
      const resposta = await fetch('/api/backups');
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) {
        throw new Error(dados.error || 'Falha ao listar backups do servidor');
      }

      const backups = Array.isArray(dados.backups) ? dados.backups : [];
      if (!backups.length) {
        d.alert('Nenhum backup encontrado no servidor', 'erro');
        return;
      }

      const opcoes = backups.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
      const escolha = window.prompt(`Escolha o numero do backup para baixar:\n\n${opcoes}`);
      if (escolha === null) return;

      const indice = Number(escolha) - 1;
      const selecionado = backups[indice];
      if (!selecionado) {
        d.alert('Opcao de backup invalida', 'erro');
        return;
      }

      const download = await fetch(`/api/backups/${encodeURIComponent(selecionado.name)}/download`);
      if (!download.ok) {
        const dadosErro = await download.json().catch(() => ({}));
        throw new Error(dadosErro.error || 'Falha ao baixar backup selecionado');
      }

      const blob = await download.blob();
      baixarBlobComoArquivo(blob, selecionado.name);
      d.alert(`Backup ${selecionado.name} baixado com sucesso`, 'sucesso');
    } catch (error) {
      d.alert(error.message || 'Erro ao baixar backup do servidor', 'erro');
    }
  }

  window.TocaBackupServer = {
    criarBackupServidor,
    baixarUltimoBackupServidor,
    baixarBackupServidorEspecifico,
  };
})();
