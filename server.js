const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const JUDILIBRE_KEY  = process.env.JUDILIBRE_KEY || 'fb846321-6eaa-4ba7-903d-9ab74374c7c5';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const JUDILIBRE_BASE = 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function judilibre(endpoint, params = {}) {
  const url = new URL(`${JUDILIBRE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'accept': 'application/json', 'KeyId': JUDILIBRE_KEY }
  });
  if (!res.ok) throw new Error(`JUDILIBRE ${res.status}: ${await res.text()}`);
  return res.json();
}

async function claude(messages, max_tokens = 1000) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY manquante dans les variables Railway');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens, messages })
  });
  const data = await res.json();
  console.log('Claude status:', res.status, 'type:', data.type);
  if (data.type === 'error') throw new Error('Claude: ' + data.error?.message || JSON.stringify(data));
  if (!data.content || !data.content[0]) throw new Error('Claude réponse vide: ' + JSON.stringify(data));
  return data.content[0].text;
}

app.get('/api/healthcheck', async (req, res) => {
  try {
    const data = await judilibre('healthcheck');
    res.json({ ok: true, judilibre: data, anthropic_key: ANTHROPIC_KEY ? 'présente' : 'manquante' });
  } catch(err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const { query, page, page_size, jurisdiction, chamber, order } = req.query;
    res.json(await judilibre('search', { query, page, page_size, jurisdiction, chamber, order }));
  } catch(err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/decision/:id', async (req, res) => {
  try {
    res.json(await judilibre('decision', { id: req.params.id }));
  } catch(err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/taxonomy', async (req, res) => {
  try {
    res.json(await judilibre('taxonomy', { target: req.query.target }));
  } catch(err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json(await judilibre('stats'));
  } catch(err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question manquante' });

  try {
    const keywords = await claude([{
      role: 'user',
      content: `Extrait 3 à 5 mots-clés juridiques pour rechercher dans une base de jurisprudence française. Question : "${question}". Réponds UNIQUEMENT avec les mots-clés séparés par des espaces, rien d'autre.`
    }], 100);

    console.log('Keywords:', keywords);

    const searchData = await judilibre('search', { query: keywords.trim(), page_size: 5 });
    const decisions = searchData.results || [];

    console.log('Decisions found:', decisions.length);

    const context = decisions.length
      ? decisions.map((d, i) => {
          const excerpt = d.highlights?.text?.[0] || d.summary?.slice(0, 300) || 'Pas d\'extrait disponible';
          return `Décision ${i+1} (${d.date || 'date inconnue'}, ${d.jurisdiction || ''}, ${d.chamber || ''}) : ${excerpt}`;
        }).join('\n\n')
      : 'Aucune décision trouvée.';

    const answer = await claude([{
      role: 'user',
      content: `Tu es un assistant juridique français. Réponds à cette question de droit en t'appuyant sur les décisions de jurisprudence suivantes.\n\nQuestion : ${question}\n\nDécisions trouvées :\n${context}\n\nDonne une réponse claire et structurée en citant les décisions.`
    }]);

    res.json({
      answer,
      keywords: keywords.trim(),
      decisions: decisions.map(d => ({
        id: d.id,
        title: d.title,
        date: d.date || d.decision_date,
        jurisdiction: d.jurisdiction,
        chamber: d.chamber,
        solution: d.solution,
        permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`,
        excerpt: d.highlights?.text?.[0] || d.summary?.slice(0, 200) || ''
      }))
    });

  } catch(err) {
    console.error('Error in /api/ask:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Jurisxium running on port ${PORT}`);
  console.log(`ANTHROPIC_KEY: ${ANTHROPIC_KEY ? 'OK' : 'MANQUANTE'}`);
  console.log(`JUDILIBRE_KEY: ${JUDILIBRE_KEY.slice(0, 8)}...`);
});
