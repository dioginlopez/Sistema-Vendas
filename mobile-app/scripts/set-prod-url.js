const fs = require('fs');
const path = require('path');

const productionUrl = 'https://sistema-vendas-58s2.onrender.com';
const configPath = path.resolve(__dirname, '..', 'capacitor.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

config.server = {
  url: productionUrl,
  cleartext: false,
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`URL de producao configurada: ${productionUrl}`);
