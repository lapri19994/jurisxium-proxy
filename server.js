const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const JUDILIBRE_KEY  = process.env.JUDILIBRE_KEY || 'fb846321-6eaa-4ba7-903d-9ab74374c7c5';
const JUDILIBRE_BASE = process.env.JUDILIBRE_ENV === 'sandbox'
  ? 'https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0'
  : 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper : appel JUDILIBRE ──────────────────────────────────────────────────
async function judilibre(endpoint, params = {}) {
  const url = new URL(`${JUDILIBRE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: {
      'accept'    : 'application/json',
      'KeyId'     : JUDILIBRE_KEY,
      'User-Agent': 'Jurisxium/1.0',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw { status: res.status, message: text };
  }
  return res.json();
}

// ── Routes proxy ──────────────────────────────────────────────────────────────

// GET /api/healthcheck
app.get('/api/healthcheck', async (req, res) => {
  try {
    const data = await judilibre('healthcheck');
    res.json({ ok: true, judilibre: data, proxy: 'Jurisxium backend v1' });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

// GET /api/search?query=...&page=0&page_size=10&jurisdiction=...&chamber=...
app.get('/api/search', async (req, res) => {
  try {
    const { query, page, page_size, jurisdiction, chamber, type, theme, formation, publication, solution, date_start, date_end, order } = req.query;
    const data = await judilibre('search', { query, page, page_size, jurisdiction, chamber, type, theme, formation, publication, solution, date_start, date_end, order });
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /api/decision/:id
app.get('/api/decision/:id', async (req, res) => {
  try {
    const data = await judilibre('decision', { id: req.params.id });
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /api/taxonomy?target=chamber
app.get('/api/taxonomy', async (req, res) => {
  try {
    const data = await judilibre('taxonomy', { target: req.query.target, context_value: req.query.context_value });
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await judilibre('stats');
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /api/export?query=...  (stream des résultats en masse)
app.get('/api/export', async (req, res) => {
  try {
    const data = await judilibre('export', { query: req.query.query, batch_size: req.query.batch_size || 50 });
    res.json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Jurisxium proxy — http://localhost:${PORT}         ║
║  API JUDILIBRE : ${JUDILIBRE_BASE.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}                   ║
║  Clé           : ${JUDILIBRE_KEY.slice(0, 8)}...              ║
╚══════════════════════════════════════════════════╝
  `);
});
