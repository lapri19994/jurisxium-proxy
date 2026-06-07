const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const JUDILIBRE_KEY     = process.env.JUDILIBRE_KEY;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_KEY;
const OAUTH_CLIENT_ID   = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

const JUDILIBRE_BASE  = 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';
const LEGIFRANCE_BASE = 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app';
const OAUTH_URL       = 'https://oauth.piste.gouv.fr/api/oauth/token';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── OAuth token cache ─────────────────────────────────────────────────────────
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
  console.log('OAuth token refreshed');
  return oauthToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function judilibre(endpoint, params = {}) {
  const url = new URL(`${JUDILIBRE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'accept': 'application/json', 'KeyId': JUDILIBRE_KEY }
  });
  if (!res.ok) throw new Error(`JUDILIBRE ${res.status}: ${await res.text()}`);
  return res.json();
}

async function legifrance(endpoint, body) {
  const token = await getOAuthToken();
  const res = await fetch(`${LEGIFRANCE_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`LEGIFRANCE ${res.status}: ${await res.text()}`);
  return res.json();
}

async function claude(messages, max_tokens = 2000) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY manquante');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens, messages })
  });
  const data = await res.json();
  if (data.type === 'error') throw new Error('Claude: ' + data.error?.message);
  if (!data.content?.[0]) throw new Error('Claude réponse vide: ' + JSON.stringify(data));
  return data.content[0].text;
}

// ── Routes de base ────────────────────────────────────────────────────────────
app.get('/api/healthcheck', async (req, res) => {
  try {
    const judilibreStatus = await judilibre('healthcheck');
    let legifranceStatus = 'non testé';
    try {
      await getOAuthToken();
      legifranceStatus = 'ok';
    } catch(e) {
      legifranceStatus = 'erreur: ' + e.message;
    }
    res.json({ ok: true, judilibre: judilibreStatus, legifrance: legifranceStatus });
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

// ── Route principale : analyse IA ─────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question manquante' });

  try {
    // Étape 1 : Claude qualifie la question juridiquement
    const qualification = await claude([{
      role: 'user',
      content: `Tu es un juriste français expert. Analyse cette question de droit et réponds en JSON strict (sans markdown) :
{
  "branches": ["droit civil", "droit du travail", etc.],
  "notions": ["notion juridique 1", "notion juridique 2"],
  "requetes_judilibre": ["requête 1", "requête 2"],
  "codes": ["Code civil", "Code du travail", etc.],
  "articles_probables": ["L. 1234-5", "2224", etc.]
}

Question : ${question}`
    }], 500);

    let parsed;
    try {
      parsed = JSON.parse(qualification.replace(/```json|```/g, '').trim());
    } catch(e) {
      parsed = { requetes_judilibre: [question], codes: [], articles_probables: [] };
    }

    console.log('Qualification:', JSON.stringify(parsed));

    // Étape 2 : Recherche en parallèle JUDILIBRE + Légifrance
    const [judilibreResults, legifranceResults] = await Promise.allSettled([

      // Multi-requêtes JUDILIBRE
      Promise.all(
        (parsed.requetes_judilibre || [question]).slice(0, 3).map(q =>
          judilibre('search', { query: q, page_size: 5 })
            .then(r => r.results || [])
            .catch(() => [])
        )
      ).then(arrays => {
        const seen = new Set();
        return arrays.flat().filter(d => {
          if (seen.has(d.id)) return false;
          seen.add(d.id);
          return true;
        }).slice(0, 10);
      }),

      // Recherche Légifrance
      (async () => {
        if (!parsed.codes?.length && !parsed.articles_probables?.length) return [];
        const searchQuery = [...(parsed.notions || []), ...(parsed.articles_probables || [])].slice(0, 3).join(' ');
        const data = await legifrance('/search', {
          recherche: {
            champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'TOUS_LES_MOTS_EXACTES', valeur: searchQuery }], operateur: 'ET' }],
            filtres: [{ facette: 'NATURE', valeurs: parsed.codes?.length ? ['CODE'] : ['CODE', 'LOI'] }],
            pageNumber: 1,
            pageSize: 5,
            operateur: 'ET',
            sort: 'PERTINENCE',
            typePagination: 'DEFAUT'
          }
        });
        return data.results || [];
      })()
    ]);

    const decisions = judilibreResults.status === 'fulfilled' ? judilibreResults.value : [];
    const lois = legifranceResults.status === 'fulfilled' ? legifranceResults.value : [];

    console.log(`Décisions: ${decisions.length}, Articles loi: ${lois.length}`);

    // Étape 3 : Récupère texte complet des 5 meilleures décisions
    const topDecisions = decisions.slice(0, 5);
    const fullDecisions = await Promise.all(
      topDecisions.map(d =>
        judilibre('decision', { id: d.id })
          .then(full => ({ ...d, fullText: full.text?.slice(0, 3000) || '' }))
          .catch(() => ({ ...d, fullText: d.highlights?.text?.[0] || '' }))
      )
    );

    // Étape 4 : Claude produit l'analyse juridique complète
    const decisionsContext = fullDecisions.map((d, i) => {
      const date = d.date || d.decision_date || '';
      const juris = d.jurisdiction || '';
      const chamber = d.chamber || '';
      return `--- Décision ${i+1} (${juris} ${chamber}, ${date}) ---\n${d.fullText || d.highlights?.text?.[0] || 'Pas de texte disponible'}`;
    }).join('\n\n');

    const loisContext = lois.length
      ? '\n\nTEXTES DE LOI PERTINENTS :\n' + lois.map((l, i) =>
          `--- Texte ${i+1} : ${l.titre || ''} ---\n${l.extract || l.resume || ''}`
        ).join('\n\n')
      : '';

    const answer = await claude([{
      role: 'user',
      content: `Tu es un juriste français expert. Produis une analyse juridique complète et structurée.

QUESTION : ${question}

QUALIFICATION JURIDIQUE : ${parsed.branches?.join(', ') || ''} — Notions : ${parsed.notions?.join(', ') || ''}

JURISPRUDENCE :
${decisionsContext}
${loisContext}

Rédige une analyse en français avec :
1. Le principe juridique applicable (avec les articles de loi si disponibles)
2. L'état de la jurisprudence (cite les décisions par leur numéro : Décision 1, Décision 2...)
3. Les nuances et exceptions
4. La conclusion pratique

Sois précis, cite les décisions et articles de loi.`
    }], 2000);

    res.json({
      answer,
      qualification: parsed,
      decisions: fullDecisions.map(d => ({
        id: d.id,
        title: d.title,
        date: d.date || d.decision_date,
        jurisdiction: d.jurisdiction,
        chamber: d.chamber,
        solution: d.solution,
        permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`,
        excerpt: d.highlights?.text?.[0] || d.fullText?.slice(0, 200) || ''
      })),
      lois: lois.map(l => ({
        titre: l.titre || '',
        nature: l.nature || '',
        url: l.url || '',
        extract: l.extract || l.resume || ''
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
  console.log(`JUDILIBRE_KEY: ${JUDILIBRE_KEY ? 'OK' : 'MANQUANTE'}`);
  console.log(`OAUTH: ${OAUTH_CLIENT_ID ? 'OK' : 'MANQUANT'}`);
});
