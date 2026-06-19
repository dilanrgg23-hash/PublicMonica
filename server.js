/*
 * Balanceador Unite - Backend
 * ---------------------------------------------------------------------------
 * Pequeno servidor Express que consulta el perfil publico de un jugador en
 * UniteAPI (https://uniteapi.dev/p/{usuario}) y devuelve los datos relevantes
 * (rango, clase, Puntos de Maestro, % de victorias, partidas) en formato JSON
 * para que la pagina del balanceador pueda calcular el "nivel" de cada jugador.
 *
 * Uso:
 *   1. npm install
 *   2. node server.js
 *   3. La pagina hace GET http://localhost:3000/api/player/<usuario>
 *
 * Nota: UniteAPI renderiza los datos en el HTML, asi que aqui se parsean con
 * expresiones regulares tolerantes. Si la web cambia su maquetacion, ajusta
 * los patrones de parsePlayerHtml().
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Fuente de datos. Se puede sobreescribir con la variable de entorno.
const UNITE_BASE = process.env.UNITE_BASE || 'https://uniteapi.dev';

app.use(cors());
app.use(express.json());

// Sirve la pagina del balanceador desde el mismo servicio, asi un solo
// despliegue gratis hospeda tanto la web como la API.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'balanceador-unite.html'));
});

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
// Parser del HTML del perfil
// ---------------------------------------------------------------------------
const RANKS = ['Principiante', 'Magnifico', 'Experto', 'Veterano', 'Ultra', 'Maestro'];
const RANKS_EN = {
  beginner: 'Principiante',
  great: 'Magnifico',
  expert: 'Experto',
  veteran: 'Veterano',
  ultra: 'Ultra',
  master: 'Maestro',
};

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m;
  }
  return null;
}

/**
 * Extrae los datos del jugador a partir del HTML del perfil.
 * Devuelve null si no encuentra senales de un perfil valido.
 */
function parsePlayerHtml(html, username) {
  if (!html || html.length < 200) return null;

  const lower = html.toLowerCase();

  // --- Rango ---
  let rank = null;
  for (const [en, es] of Object.entries(RANKS_EN)) {
    if (lower.includes(en) || lower.includes(es.toLowerCase())) {
      rank = es;
      // No rompemos: el rango mas alto encontrado gana (orden del objeto).
    }
  }

  // --- Clase dentro del rango (1-5) ---
  let rankClass = null;
  const classMatch = firstMatch(html, [
    /clase\s*([1-5])/i,
    /class\s*([1-5])/i,
  ]);
  if (classMatch) rankClass = parseInt(classMatch[1], 10);

  // --- Puntos de Maestro (solo rango Maestro) ---
  let masterPoints = null;
  const mpMatch = firstMatch(html, [
    /puntos?\s*de\s*maestr[oa][^0-9]{0,20}([0-9][0-9.,]*)/i,
    /master\s*points?[^0-9]{0,20}([0-9][0-9.,]*)/i,
    /\bMP\b[^0-9]{0,10}([0-9][0-9.,]*)/i,
  ]);
  if (mpMatch) masterPoints = parseInt(mpMatch[1].replace(/[.,]/g, ''), 10);

  // --- % de victorias ---
  let winRate = null;
  const wrMatch = firstMatch(html, [
    /win\s*rate[^0-9]{0,15}([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i,
    /victorias?[^0-9]{0,15}([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i,
    /([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*(?:win|victorias?)/i,
  ]);
  if (wrMatch) winRate = parseFloat(wrMatch[1]);

  // --- Partidas jugadas ---
  let games = null;
  const gMatch = firstMatch(html, [
    /partidas?[^0-9]{0,15}([0-9][0-9.,]*)/i,
    /matches?\s*played[^0-9]{0,15}([0-9][0-9.,]*)/i,
    /games?\s*played[^0-9]{0,15}([0-9][0-9.,]*)/i,
  ]);
  if (gMatch) games = parseInt(gMatch[1].replace(/[.,]/g, ''), 10);

  if (!rank && winRate === null && games === null) {
    // No parece un perfil con datos.
    return null;
  }

  return {
    username,
    rank: rank || 'Principiante',
    rankClass,
    masterPoints,
    winRate: winRate !== null ? winRate : null,
    games: games !== null ? games : null,
    source: 'uniteapi',
  };
}

// ---------------------------------------------------------------------------
// Obtencion del perfil
// ---------------------------------------------------------------------------
async function fetchPlayer(username) {
  const url = `${UNITE_BASE}/p/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; BalanceadorUnite/1.0; +https://github.com/)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!res.ok) {
    const err = new Error(`UniteAPI respondio ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const html = await res.text();
  return parsePlayerHtml(html, username);
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, base: UNITE_BASE, ttlMs: CACHE_TTL_MS });
});

app.get('/api/player/:username', async (req, res) => {
  const username = (req.params.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Falta el nombre de usuario' });
  }

  const cached = getCached(username.toLowerCase());
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const data = await fetchPlayer(username);
    if (!data) {
      return res
        .status(404)
        .json({ error: `No se encontro el perfil "${username}"`, found: false });
    }
    setCached(username.toLowerCase(), data);
    res.json({ ...data, cached: false });
  } catch (err) {
    console.error(`Error consultando "${username}":`, err.message);
    res
      .status(err.status === 404 ? 404 : 502)
      .json({ error: err.message, found: false });
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
      const username = String(u || '').trim();
      if (!username) return { username: u, error: 'vacio', found: false };

      const cached = getCached(username.toLowerCase());
      if (cached) return { ...cached, cached: true };

      try {
        const data = await fetchPlayer(username);
        if (!data) return { username, error: 'no encontrado', found: false };
        setCached(username.toLowerCase(), data);
        return { ...data, cached: false };
      } catch (err) {
        return { username, error: err.message, found: false };
      }
    })
  );

  res.json({ resultados });
});

app.listen(PORT, () => {
  console.log(`Balanceador Unite backend escuchando en http://localhost:${PORT}`);
  console.log(`Fuente de datos: ${UNITE_BASE}`);
});
