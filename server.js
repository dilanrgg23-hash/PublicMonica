/*
 * Balanceador Unite - Backend (v2, navegador headless)
 * ---------------------------------------------------------------------------
 * uniteapi.dev protege sus perfiles con Cloudflare y rechaza (403) las
 * peticiones normales de un servidor. Por eso aqui usamos un NAVEGADOR REAL
 * headless (Puppeteer + stealth) que abre la pagina, deja que Cloudflare pase
 * y lee los datos ya renderizados.
 *
 * Devuelve el % de victorias HISTORICO (todos los modos) + victorias/derrotas
 * /partidas, para que el balanceador arme equipos parejos por win%.
 *
 * Rutas:
 *   GET /                  -> la pagina del balanceador
 *   GET /api/player/<ID>   -> datos del jugador (ID o URL del perfil)
 *   GET /api/debug/<ID>    -> diagnostico (que se extrajo / texto renderizado)
 *   GET /api/health        -> estado
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const UNITE_BASE = process.env.UNITE_BASE || 'https://uniteapi.dev';

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Servir la pagina del balanceador
// ---------------------------------------------------------------------------
function findHtmlFile() {
  const preferidos = ['balanceador-unite.html', 'balanceadorunite.html', 'index.html'];
  for (const nombre of preferidos) {
    const ruta = path.join(__dirname, nombre);
    if (fs.existsSync(ruta)) return ruta;
  }
  try {
    const html = fs.readdirSync(__dirname).find((f) => f.toLowerCase().endsWith('.html'));
    if (html) return path.join(__dirname, html);
  } catch (_) {}
  return null;
}

app.get('/', (req, res) => {
  const archivo = findHtmlFile();
  if (archivo) return res.sendFile(archivo);
  res.status(404).send('No se encontro el HTML del balanceador en el servidor.');
});

// ---------------------------------------------------------------------------
// Cache en memoria
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  cache.delete(key);
  return null;
}
function setCached(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Extraccion de datos
// ---------------------------------------------------------------------------
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

// Busca recursivamente en el JSON el agregado victorias/derrotas con MAS
// partidas (= historico de todos los modos). Ej: 2824/5080 => 55.6%.
function deepFindWinStats(obj) {
  let best = null;
  function num(node, names) {
    for (const k of Object.keys(node)) {
      if (names.includes(k.toLowerCase()) && typeof node[k] === 'number') return node[k];
    }
    return null;
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const wins = num(node, ['wins', 'win', 'victories', 'victorias', 'won']);
    const losses = num(node, ['losses', 'loss', 'defeats', 'derrotas', 'lost']);
    const matches = num(node, [
      'matches', 'games', 'partidas', 'battles', 'played',
      'gamesplayed', 'totalmatches', 'totalgames', 'total',
    ]);
    if (wins !== null && (losses !== null || matches !== null)) {
      const total = matches !== null ? matches : wins + losses;
      if (total > 0 && wins <= total && (!best || total > best.games)) {
        best = {
          wins,
          losses: losses !== null ? losses : total - wins,
          games: total,
          winRate: Math.round((wins / total) * 1000) / 10,
        };
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(obj);
  return best;
}

// Fallback: extrae victorias/derrotas/partidas del TEXTO renderizado de la
// pagina (cuando los datos no estan en __NEXT_DATA__ sino cargados por JS).
function extractFromText(text) {
  if (!text) return null;
  const t = text.replace(/ /g, ' ');
  const numNear = (label) => {
    const re1 = new RegExp('([\\d][\\d.,]{0,12})\\s*' + label, 'i');
    const re2 = new RegExp(label + '[^\\d]{0,6}([\\d][\\d.,]{0,12})', 'i');
    const m = t.match(re1) || t.match(re2);
    return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null;
  };
  const victorias = numNear('VICTORIAS') ?? numNear('WINS');
  const derrotas = numNear('DERROTAS') ?? numNear('LOSSES');
  const partidas = numNear('PARTIDAS') ?? numNear('MATCHES') ?? numNear('GAMES');

  if (victorias != null && (derrotas != null || partidas != null)) {
    const games = partidas != null ? partidas : victorias + derrotas;
    if (games > 0 && victorias <= games) {
      return {
        wins: victorias,
        losses: derrotas != null ? derrotas : games - victorias,
        games,
        winRate: Math.round((victorias / games) * 1000) / 10,
      };
    }
  }
  return null;
}

function parseProfile({ html, text, id }) {
  let stats = null;
  let via = null;

  const data = html ? extractNextData(html) : null;
  if (data) {
    stats = deepFindWinStats(data);
    if (stats) via = '__NEXT_DATA__';
  }
  if (!stats) {
    stats = extractFromText(text);
    if (stats) via = 'texto-renderizado';
  }
  if (!stats) return null;

  let name = String(id);
  let rank = null;
  let masterPoints = null;
  if (data) {
    const findStr = (keys) => {
      let f = null;
      (function w(n) {
        if (f || !n || typeof n !== 'object') return;
        for (const k of Object.keys(n)) {
          if (typeof n[k] === 'string' && n[k].trim() && keys.includes(k.toLowerCase())) {
            f = n[k].trim(); return;
          }
          if (n[k] && typeof n[k] === 'object') w(n[k]);
        }
      })(data);
      return f;
    };
    name = findStr(['name', 'username', 'nickname', 'displayname', 'ign']) || name;
    rank = findStr(['rank', 'tier', 'rankname', 'currentrank']);
  }

  return {
    id: String(id),
    name,
    rank,
    masterPoints,
    winRate: stats.winRate,
    wins: stats.wins,
    losses: stats.losses,
    games: stats.games,
    via,
    source: 'uniteapi',
  };
}

// ---------------------------------------------------------------------------
// Navegador headless (reutilizado entre peticiones)
// ---------------------------------------------------------------------------
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
    ],
  });
  return browserPromise;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Abre el perfil con un navegador real y devuelve { html, text }.
async function fetchProfileRendered(id) {
  const url = `${UNITE_BASE}/es/p/${encodeURIComponent(id)}`;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp ? resp.status() : 0;

    // Espera a que Cloudflare pase y aparezcan datos (NEXT_DATA o el texto).
    await page
      .waitForFunction(
        () => {
          const txt = document.body ? document.body.innerText : '';
          return (
            document.querySelector('#__NEXT_DATA__') ||
            /VICTORIAS|DERROTAS|PARTIDAS|WIN%/i.test(txt)
          );
        },
        { timeout: 35000 }
      )
      .catch(() => {});

    // Pequena espera extra para que terminen de cargar las cifras.
    await new Promise((r) => setTimeout(r, 1500));

    const html = await page.content();
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return { html, text, status };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchPlayer(id) {
  const { html, text } = await fetchProfileRendered(id);
  return parseProfile({ html, text, id });
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, base: UNITE_BASE, ttlMs: CACHE_TTL_MS, engine: 'puppeteer' });
});

function cleanId(raw) {
  const m = String(raw || '').match(/(\d{6,})/);
  return m ? m[1] : String(raw || '').trim();
}

app.get('/api/player/:id', async (req, res) => {
  const id = cleanId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Falta el ID del perfil' });

  const cached = getCached(id);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const data = await fetchPlayer(id);
    if (!data) {
      return res.status(404).json({
        error: `No se pudieron leer los datos del perfil ${id}`,
        found: false,
      });
    }
    setCached(id, data);
    res.json({ ...data, cached: false });
  } catch (err) {
    console.error(`Error consultando ${id}:`, err.message);
    res.status(502).json({ error: err.message, found: false });
  }
});

// Diagnostico: muestra lo extraido y un trozo del texto renderizado, para
// verificar contra la pagina y afinar la extraccion.
app.get('/api/debug/:id', async (req, res) => {
  const id = cleanId(req.params.id);
  try {
    const { html, text, status } = await fetchProfileRendered(id);
    const data = parseProfile({ html, text, id });
    res.json({
      id,
      statusInicial: status,
      tieneNextData: /id="__NEXT_DATA__"/.test(html),
      htmlBytes: html.length,
      extraido: data,
      textoRenderizado: (text || '').replace(/\n+/g, ' | ').slice(0, 1200),
    });
  } catch (err) {
    res.status(502).json({ id, error: err.message });
  }
});

app.post('/api/players', async (req, res) => {
  const usuarios = Array.isArray(req.body && req.body.usuarios) ? req.body.usuarios : [];
  if (!usuarios.length) return res.status(400).json({ error: 'Envia { "usuarios": [...] }' });

  // En serie para no agotar la memoria del navegador en hosting gratis.
  const resultados = [];
  for (const u of usuarios) {
    const id = cleanId(u);
    if (!id) { resultados.push({ id: u, error: 'vacio', found: false }); continue; }
    const cached = getCached(id);
    if (cached) { resultados.push({ ...cached, cached: true }); continue; }
    try {
      const data = await fetchPlayer(id);
      if (!data) { resultados.push({ id, error: 'no encontrado', found: false }); continue; }
      setCached(id, data);
      resultados.push({ ...data, cached: false });
    } catch (err) {
      resultados.push({ id, error: err.message, found: false });
    }
  }
  res.json({ resultados });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Balanceador Unite (headless) escuchando en http://localhost:${PORT}`);
    console.log(`Fuente: ${UNITE_BASE}`);
  });
}

module.exports = { extractNextData, deepFindWinStats, extractFromText, parseProfile, cleanId };
