const fs = require('fs');
const os = require('os');
const path = require('path');

function isPrivateIPv4(ip) {
  return ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

function getBestIPv4() {
  const interfaces = os.networkInterfaces();
  const all = [];

  Object.values(interfaces).forEach((entries) => {
    (entries || []).forEach((item) => {
      if (!item || item.internal || item.family !== 'IPv4') {
        return;
      }
      all.push(item.address);
    });
  });

  if (all.length === 0) {
    return null;
  }

  const privateIPs = all.filter(isPrivateIPv4);
  if (privateIPs.length > 0) {
    return privateIPs[0];
  }

  return all[0];
}

const configPath = path.resolve(__dirname, '..', 'capacitor.config.json');
const configRaw = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(configRaw);

const detectedIp = getBestIPv4();
const targetHost = detectedIp || '10.0.2.2';
const targetUrl = `http://${targetHost}:3000`;

config.server = {
  ...(config.server || {}),
  url: targetUrl,
  cleartext: true,
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

if (detectedIp) {
  console.log(`Servidor mobile configurado automaticamente para: ${targetUrl}`);
} else {
  console.log('IP local nao encontrado. Usando fallback de emulador Android (10.0.2.2).');
  console.log(`Servidor mobile configurado para: ${targetUrl}`);
}
