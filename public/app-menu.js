// Este script carrega os produtos do backend e monta o cardápio por categoria
async function carregarCardapio() {
    const container = document.getElementById('menu-container');
    container.innerHTML = 'Carregando cardápio...';
    try {
        // Ajuste a URL conforme seu backend ou API
        const resp = await fetch('/products');
        if (!resp.ok) throw new Error('Erro ao buscar produtos');
        const produtos = await resp.json();
        // Agrupa produtos por categoria
            const categorias = {};
            produtos.forEach(prod => {
                if (!categorias[prod.categoria]) categorias[prod.categoria] = [];
                categorias[prod.categoria].push(prod);
            });
            // Monta o HTML
            let html = '';
            Object.keys(categorias).forEach(cat => {
                html += `<div class="categoria">
                            <h2>${cat}</h2>
                            <div class="produtos-grid">`;
                categorias[cat].forEach(prod => {
                    // Usa imagemUrl, imagem, ou placeholder
                    const img = prod.imagemUrl || prod.imagem || 'https://via.placeholder.com/150';
                    html += `<div class="produto-card">
                                <img src="${img}" alt="${prod.nome}">
                                <div class="produto-nome">${prod.nome}</div>
                                <div class="produto-preco">R$ ${Number(prod.preco).toFixed(2)}</div>
                            </div>`;
                });
                html += '</div></div>';
            });
            container.innerHTML = html;
    } catch (e) {
        container.innerHTML = 'Erro ao carregar cardápio.';
    }
}

window.addEventListener('DOMContentLoaded', carregarCardapio);
