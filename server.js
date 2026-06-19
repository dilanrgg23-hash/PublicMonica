/*
 * Balanceador Unite - Backend
 * ---------------------------------------------------------------------------
 * Servidor Express que lee el perfil publico de un jugador en UniteAPI
 * (https://uniteapi.dev/es/p/{ID}) y devuelve el % de victorias HISTORICO
 * (todos los modos) junto con victorias/derrotas/partidas, para que el
 * balanceador arme equipos parejos segun ese win% real.
 *
 * uniteapi.dev es una web Next.js: los datos vienen en el JSON embebido del
 * <script id="__NEXT_DATA__">. Por eso leemos ese JSON (no texto suelto) y las
 * cifras coinciden EXACTAMENTE con la pagina.
 *
 * Uso:
 *   1. npm install
 *   2. node server.js
 *   3. GET /api/player/<ID>   -> datos del jugador
 *      GET /api/debug/<ID>    -> diagnostico (que se extrajo del perfil)
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Fuente de datos. Se puede sobreescribir con la variable de entorno.
const UNITE_BASE = process.env.UNITE_BASE || 'https://uniteapi.dev';

app.use(cors());
app.use(express.json());

// Localiza el archivo HTML del balanceador sin depender del nombre exacto
// (balanceador-unite.html, balanceadorunite.html, index.html, o el primer .html).
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

// Sirve la pagina del balanceador desde el mismo servicio, asi un solo
// despliegue gratis hospeda tanto la web como la API.
app.get('/', (req, res) => {
  const archivo = findHtmlFile();
  if (archivo) return res.sendFile(archivo);
  res
    .status(404)
    .send('No se encontro el HTML del balanceador en el servidor.');
});

// Tambien expone los archivos estaticos (por si hay assets junto al HTML).
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Cache simple en memoria para no martillear a UniteAPI
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const cache = new Map(); // username -> { data, expires }

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
// Parser de datos reales del perfil
// ---------------------------------------------------------------------------
// uniteapi.dev es una web Next.js: los datos vienen en un JSON embebido en el
// <script id="__NEXT_DATA__">. Leemos ese JSON (no texto suelto) para que las
// cifras coincidan EXACTAMENTE con lo que muestra la pagina.

function extractNextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

// Busca recursivamente, dentro del JSON, el agregado de victorias/derrotas que
// representa el HISTORICO de TODOS los modos (el de mayor numero de partidas,
// p. ej. 2824 victorias / 5080 partidas => 55.6%).
function deepFindWinStats(obj) {
  let best = null;

  function num(node, names) {
    for (const k of Object.keys(node)) {
      if (names.includes(k.toLowerCase()) && typeof node[k] === 'number') {
        return node[k];
      }
    }
    return null;
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
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

// Busca el primer string "interesante" para nombre / rango.
function deepFindString(obj, keyNames) {
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (
        typeof v === 'string' &&
        v.trim() &&
        keyNames.includes(k.toLowerCase())
      ) {
        found = v.trim();
        return;
      }
      if (v && typeof v === 'object') walk(v);
    }
  })(obj);
  return found;
}

/**
 * Convierte el JSON del perfil en los datos que usa el balanceador.
 * Devuelve tambien `_debug` para poder verificar contra la pagina.
 */
function parseProfile(html, id) {
  if (!html || html.length < 200) return null;

  const data = extractNextData(html);
  if (!data) return null;

  const stats = deepFindWinStats(data);
  if (!stats) return null;

  const name =
    deepFindString(data, ['name', 'username', 'nickname', 'displayname', 'ign']) ||
    String(id);
  const rank =
    deepFindString(data, ['rank', 'tier', 'rankname', 'currentrank']) || null;
  let masterPoints = null;
  (function findMp(node) {
    if (masterPoints !== null || !node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      if (
        ['masterpoints', 'mp', 'masterpoint'].includes(k.toLowerCase()) &&
        typeof node[k] === 'number'
      ) {
        masterPoints = node[k];
        return;
      }
      if (node[k] && typeof node[k] === 'object') findMp(node[k]);
    }
  })(data);

  return {
    id: String(id),
    name,
    rank,
    masterPoints,
    winRate: stats.winRate,
    wins: stats.wins,
    losses: stats.losses,
    games: stats.games,
    source: 'uniteapi',
  };
}

// ---------------------------------------------------------------------------
// Obtencion del perfil
// ---------------------------------------------------------------------------
async function fetchProfileHtml(id) {
  const url = `${UNITE_BASE}/es/p/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
  });
  if (!res.ok) {
    const err = new Error(`UniteAPI respondio ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

async function fetchPlayer(id) {
  const html = await fetchProfileHtml(id);
  return parseProfile(html, id);
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, base: UNITE_BASE, ttlMs: CACHE_TTL_MS });
});

function cleanId(raw) {
  // Acepta un ID suelto o una URL completa del perfil.
  const m = String(raw || '').match(/(\d{6,})/);
  return m ? m[1] : String(raw || '').trim();
}

app.get('/api/player/:id', async (req, res) => {
  const id = cleanId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Falta el ID del perfil' });
  }

  const cached = getCached(id);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

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
    res
      .status(err.status === 404 ? 404 : 502)
      .json({ error: err.message, found: false });
  }
});

// Endpoint de diagnostico: muestra lo que el backend logro extraer del perfil,
// para comparar contra lo que se ve en la pagina y afinar el parser.
app.get('/api/debug/:id', async (req, res) => {
  const id = cleanId(req.params.id);
  try {
    const html = await fetchProfileHtml(id);
    const tieneNextData = /id="__NEXT_DATA__"/.test(html);
    const data = parseProfile(html, id);
    res.json({
      id,
      htmlBytes: html.length,
      tieneNextData,
      extraido: data,
      pista: data
        ? 'OK: revisa que winRate/games coincidan con la pagina'
        : 'No se encontraron stats en __NEXT_DATA__ (quiza la data se carga por API aparte)',
    });
  } catch (err) {
    res.status(502).json({ id, error: err.message });
  }
});

// Consulta en lote: POST { usuarios: ["a","b",...] }
app.post('/api/players', async (req, res) => {
  const usuarios = Array.isArray(req.body && req.body.usuarios)
    ? req.body.usuarios
    : [];
  if (!usuarios.length) {
    return res.status(400).json({ error: 'Envia { "usuarios": [...] }' });
  }

  const resultados = await Promise.all(
    usuarios.map(async (u) => {
      const id = cleanId(u);
      if (!id) return { id: u, error: 'vacio', found: false };

      const cached = getCached(id);
      if (cached) return { ...cached, cached: true };

      try {
        const data = await fetchPlayer(id);
        if (!data) return { id, error: 'no encontrado', found: false };
        setCached(id, data);
        return { ...data, cached: false };
      } catch (err) {
        return { id, error: err.message, found: false };
      }
    })
  );

  res.json({ resultados });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Balanceador Unite backend escuchando en http://localhost:${PORT}`);
    console.log(`Fuente de datos: ${UNITE_BASE}`);
  });
}

// Exportado para pruebas.
module.exports = { extractNextData, deepFindWinStats, parseProfile, cleanId };
