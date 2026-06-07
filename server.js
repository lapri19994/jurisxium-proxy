const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const JUDILIBRE_KEY       = process.env.JUDILIBRE_KEY;
const ANTHROPIC_KEY       = process.env.ANTHROPIC_KEY;
const OAUTH_CLIENT_ID     = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

const JUDILIBRE_BASE  = 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';
const LEGIFRANCE_BASE = 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app';
const OAUTH_URL       = 'https://oauth.piste.gouv.fr/api/oauth/token';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── OAuth ─────────────────────────────────────────────────────────────────────
let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      scope: 'openid'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth failed: ' + JSON.stringify(data));
  oauthToken = data.access_token;
  oauthExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return oauthToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function judilibre(endpoint, params = {}) {
  const url = new URL(`${JUDILIBRE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: { 'accept': 'application/json', 'KeyId': JUDILIBRE_KEY }
  });
  if (!res.ok) throw new Error(`JUDILIBRE ${res.status}: ${await res.text()}`);
  return res.json();
}

async function legifranceSearch(query) {
  try {
    const token = await getOAuthToken();
    const res = await fetch(`${LEGIFRANCE_BASE}/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recherche: {
          champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'TOUS_LES_MOTS_EXACTES', valeur: query }], operateur: 'ET' }],
          filtres: [{ facette: 'NATURE', valeurs: ['CODE', 'LOI'] }],
          pageNumber: 1, pageSize: 5, operateur: 'ET', sort: 'PERTINENCE', typePagination: 'DEFAUT'
        }
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch(e) { return []; }
}

async function claude(messages, max_tokens = 3000) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY manquante');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens, messages })
  });
  const data = await res.json();
  if (data.type === 'error') throw new Error('Claude: ' + data.error?.message);
  if (!data.content?.[0]) throw new Error('Claude réponse vide');
  return data.content[0].text;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/healthcheck', async (req, res) => {
  try {
    const j = await judilibre('healthcheck');
    let lf = 'non testé';
    try { await getOAuthToken(); lf = 'ok'; } catch(e) { lf = 'erreur: ' + e.message; }
    res.json({ ok: true, judilibre: j, legifrance: lf });
  } catch(err) { res.status(502).json({ ok: false, error: err.message }); }
});

// Qualification
app.post('/api/qualify', async (req, res) => {
  const { facts } = req.body;
  if (!facts) return res.status(400).json({ error: 'Faits manquants' });
  try {
    const raw = await claude([{
      role: 'user',
      content: `Tu es un juriste français expert. Analyse ces faits et identifie les problèmes de droit.

RÈGLES :
- Chaque question = UN problème de droit distinct avec sa propre règle juridique autonome
- Pas de recoupement : si deux questions ont la même règle → fusionner
- Maximum 5 questions, minimum 2
- Question = vraie question juridique à trancher, pas un titre de cours

JSON strict sans markdown :
{
  "resume_faits": "3-5 phrases, faits purs",
  "questions_droit": [
    { "id": 1, "titre": "Titre court", "description": "Question précise", "branches": ["droit commercial"] }
  ]
}

Faits : ${facts}`
    }], 1500);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Étape 1 : génère les requêtes pour une question
app.post('/api/get-queries', async (req, res) => {
  const { question, facts } = req.body;
  try {
    const raw = await claude([{
      role: 'user',
      content: `Juriste français. Génère des requêtes JUDILIBRE pour cette question juridique.
Question : "${question.titre}" — ${question.description}
Faits : ${facts}

Règles :
- 2-4 mots par requête, termes concrets qui apparaissent dans les décisions
- 4 à 6 requêtes, de la plus spécifique à la plus large

JSON strict : {"requetes": ["req1", "req2", ...]}`
    }], 400);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Étape 2 : cherche une page de JP pour une requête donnée
app.post('/api/search-jp', async (req, res) => {
  const { query, page = 0 } = req.body;
  try {
    const data = await judilibre('search', { query, page_size: 10, page });
    const decisions = data.results || [];

    // Récupère texte complet en parallèle (max 5 pour pas dépasser timeout)
    const enriched = await Promise.all(
      decisions.slice(0, 5).map(async d => {
        try {
          const full = await judilibre('decision', { id: d.id });
          return {
            id: d.id,
            date: d.date || d.decision_date,
            jurisdiction: d.jurisdiction,
            chamber: d.chamber,
            solution: d.solution,
            permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`,
            excerpt: d.highlights?.text?.[0] || '',
            fullText: (full.text || '').slice(0, 2000)
          };
        } catch(e) {
          return {
            id: d.id,
            date: d.date || d.decision_date,
            jurisdiction: d.jurisdiction,
            chamber: d.chamber,
            solution: d.solution,
            permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`,
            excerpt: d.highlights?.text?.[0] || '',
            fullText: ''
          };
        }
      })
    );

    res.json({ decisions: enriched, total: data.total || 0, has_more: decisions.length === 10 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Étape 3 : évalue si les JP sont suffisantes
app.post('/api/evaluate-jp', async (req, res) => {
  const { question, decisions } = req.body;
  if (!decisions?.length) return res.json({ sufficient: false });
  try {
    const sample = decisions.slice(0, 8).map((d, i) =>
      `[${i+1}] ${d.jurisdiction||''} ${d.chamber||''} ${d.date||''} : ${d.fullText?.slice(0, 400) || d.excerpt}`
    ).join('\n');
    const raw = await claude([{
      role: 'user',
      content: `Question : "${question.titre}" — ${question.description}

Décisions trouvées :
${sample}

Ces décisions répondent-elles directement à la question posée ?
JSON strict : {"sufficient": true/false, "reason": "court"}`
    }], 200);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.json({ sufficient: false }); }
});

// Étape 4 : génère nouvelles requêtes si insuffisant
app.post('/api/new-queries', async (req, res) => {
  const { question, tried_queries } = req.body;
  try {
    const raw = await claude([{
      role: 'user',
      content: `Question juridique : "${question.titre}"
Requêtes déjà essayées sans résultat suffisant : ${tried_queries.join(', ')}
Génère 3 nouvelles requêtes DIFFÉRENTES pour JUDILIBRE (2-4 mots, termes concrets).
JSON strict : {"requetes": ["req1","req2","req3"]}`
    }], 200);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Étape 5 : rédige l'analyse finale
app.post('/api/write-analysis', async (req, res) => {
  const { question, facts, decisions, lois } = req.body;

  const jpContext = decisions.slice(0, 20).map((d, i) =>
    `[${i+1}] ${d.jurisdiction||''} ${d.chamber||''} ${d.date||''} (${d.permalink}) :\n${d.fullText?.slice(0, 1500) || d.excerpt}`
  ).join('\n\n');

  const loiContext = lois?.length
    ? 'TEXTES DE LOI :\n' + lois.map(l => `${l.titre||''} : ${l.extract||''}`).join('\n')
    : '';

  try {
    const analysis = await claude([{
      role: 'user',
      content: `Tu es un juriste français expert. Rédige l'analyse de cette seule question en syllogisme juridique.

QUESTION : "${question.titre}"
${question.description}

FAITS : ${facts}

${loiContext}

JURISPRUDENCE (${decisions.length} décisions analysées) :
${jpContext}

FORMAT OBLIGATOIRE :

## Majeure — La règle de droit
Règle applicable : articles de loi (numéros précis) et jurisprudence. Pour chaque décision citée, intègre le lien : [Cass. com., 12 jan. 2020](URL). Ne cite que les décisions DIRECTEMENT pertinentes.

## Mineure — En l'espèce
"En l'espèce," puis qualification des faits concrets par rapport à la règle.

## Conclusion — Dès lors
"Dès lors," puis réponse nette. Si jurisprudence contradictoire ou insuffisante : nuance les deux positions clairement.

RÈGLES :
- Cette question UNIQUEMENT
- Liens des décisions intégrés dans le texte
- Si JP insuffisante : raisonner sur les textes et le dire
- Pas d'introduction ni de recommandations stratégiques`
    }], 2500);

    res.json({ analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Chat
app.post('/api/chat', async (req, res) => {
  const { message, history = [], context = '' } = req.body;
  try {
    const reply = await claude([
      { role: 'user', content: `Tu es un juriste français expert.\nContexte : ${context}\n\nQuestion : ${message}` },
      ...history.slice(-6)
    ], 1000);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Jurisxium running on port ${PORT}`);
  console.log(`ANTHROPIC_KEY: ${ANTHROPIC_KEY ? 'OK' : 'MANQUANTE'}`);
  console.log(`JUDILIBRE_KEY: ${JUDILIBRE_KEY ? 'OK' : 'MANQUANTE'}`);
});
