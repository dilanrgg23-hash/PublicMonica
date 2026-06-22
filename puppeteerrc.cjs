// Guarda Chromium dentro del proyecto para que en Render (y otros hosts)
// el binario descargado en el build siga disponible al ejecutar.
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
