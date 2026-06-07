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
  console.log('OAuth token refreshed');
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
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        recherche: {
          champs: [{
            typeChamp: 'ALL',
            criteres: [{ typeRecherche: 'TOUS_LES_MOTS_EXACTES', valeur: query }],
            operateur: 'ET'
          }],
          filtres: [{ facette: 'NATURE', valeurs: ['CODE', 'LOI', 'ORDONNANCE'] }],
          pageNumber: 1,
          pageSize: 5,
          operateur: 'ET',
          sort: 'PERTINENCE',
          typePagination: 'DEFAUT'
        }
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch(e) {
    console.log('Legifrance error:', e.message);
    return [];
  }
}

async function claude(messages, max_tokens = 3000) {
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
  if (!data.content?.[0]) throw new Error('Claude réponse vide');
  return data.content[0].text;
}

async function searchJP(queries, page = 0) {
  const results = [];
  for (const q of queries) {
    try {
      const data = await judilibre('search', { query: q, page_size: 8, page });
      const decisions = data.results || [];
      const fullDecisions = await Promise.all(
        decisions.slice(0, 5).map(d =>
          judilibre('decision', { id: d.id })
            .then(full => ({ ...d, fullText: (full.text || '').slice(0, 2000) }))
            .catch(() => ({ ...d, fullText: d.highlights?.text?.[0] || '' }))
        )
      );
      results.push({
        query: q,
        total: data.total || 0,
        count: decisions.length,
        decisions: fullDecisions.map(d => ({
          id: d.id,
          title: d.title,
          date: d.date || d.decision_date,
          jurisdiction: d.jurisdiction,
          chamber: d.chamber,
          solution: d.solution,
          permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`,
          excerpt: d.highlights?.text?.[0] || d.fullText?.slice(0, 300) || '',
          fullText: d.fullText
        }))
      });
    } catch(e) {
      results.push({ query: q, total: 0, count: 0, decisions: [], error: e.message });
    }
  }
  return results;
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

// Étape 1 : qualifier les faits et identifier les questions de droit
app.post('/api/qualify', async (req, res) => {
  const { facts, history = [] } = req.body;
  if (!facts) return res.status(400).json({ error: 'Faits manquants' });

  const messages = [
    ...history,
    {
      role: 'user',
      content: `Tu es un juriste français expert. Analyse ces faits et réponds en JSON strict (sans markdown) :
{
  "resume_faits": "Résumé factuel en 3-5 phrases",
  "questions_droit": [
    {
      "id": 1,
      "titre": "Titre court de la question",
      "description": "Description précise de la question juridique",
      "branches": ["droit civil", etc.],
      "pertinence": "Pourquoi cette question est centrale"
    }
  ]
}

Faits : ${facts}`
    }
  ];

  try {
    const raw = await claude(messages, 1500);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Étape 2 : analyser une question spécifique
app.post('/api/analyze-question', async (req, res) => {
  const { question, facts, history = [], page = 0 } = req.body;
  if (!question || !facts) return res.status(400).json({ error: 'Données manquantes' });

  try {
    // Claude génère les requêtes de recherche
    const queriesRaw = await claude([{
      role: 'user',
      content: `Tu es un juriste français. Pour analyser cette question juridique, génère les requêtes de recherche JUDILIBRE optimales.
Réponds en JSON strict :
{
  "requetes_judilibre": ["requête 1", "requête 2", ...],
  "requetes_legifrance": ["requête loi 1", "requête loi 2"],
  "articles_cibles": ["L. 1234-5", "2224", etc.]
}

Règles pour les requêtes JUDILIBRE :
- 2 à 5 mots maximum par requête
- Termes qui apparaissent dans les décisions (pas des concepts abstraits)
- Entre 1 et 5 requêtes selon la complexité

Question : ${question.titre} — ${question.description}
Faits : ${facts}`
    }], 500);

    let queries;
    try {
      queries = JSON.parse(queriesRaw.replace(/```json|```/g, '').trim());
    } catch(e) {
      queries = { requetes_judilibre: [question.titre], requetes_legifrance: [], articles_cibles: [] };
    }

    // Recherche JP + Loi en parallèle
    const [jpResults, loiResults] = await Promise.all([
      searchJP(queries.requetes_judilibre, page),
      queries.requetes_legifrance?.length
        ? legifranceSearch(queries.requetes_legifrance[0])
        : Promise.resolve([])
    ]);

    // Contexte pour Claude
    const jpContext = jpResults.map(r =>
      `Requête "${r.query}" (${r.count} JP) :\n` +
      r.decisions.map((d, i) => `  [${i+1}] ${d.jurisdiction || ''} ${d.chamber || ''} ${d.date || ''} : ${d.fullText?.slice(0, 500) || d.excerpt}`).join('\n')
    ).join('\n\n');

    const loiContext = loiResults.length
      ? 'TEXTES DE LOI :\n' + loiResults.map(l => `${l.titre || ''} : ${l.extract || ''}`).join('\n')
      : '';

    const messages = [
      ...history,
      {
        role: 'user',
        content: `Tu es un juriste français expert. Analyse cette question de droit.

FAITS : ${facts}

QUESTION : ${question.titre}
${question.description}

${loiContext}

JURISPRUDENCE TROUVÉE :
${jpContext}

Rédige une analyse structurée :
1. Principe juridique applicable (cite les articles précis avec leur numéro)
2. État de la jurisprudence (cite les décisions par [numéro] ex: [1], [2]...)
3. Nuances et exceptions
4. Conclusion sur cette question

Sois précis et cite les sources.`
      }
    ];

    const analysis = await claude(messages, 2000);

    res.json({
      question,
      queries: queries.requetes_judilibre,
      jp_results: jpResults.map(r => ({
        query: r.query,
        count: r.count,
        total: r.total,
        decisions: r.decisions.map(d => ({
          id: d.id,
          date: d.date,
          jurisdiction: d.jurisdiction,
          chamber: d.chamber,
          solution: d.solution,
          permalink: d.permalink,
          excerpt: d.excerpt
        }))
      })),
      loi_results: loiResults.map(l => ({
        titre: l.titre || '',
        nature: l.nature || '',
        url: l.url || '',
        extract: (l.extract || '').slice(0, 400)
      })),
      analysis,
      page
    });

  } catch(e) {
    console.error('analyze-question error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Étape 3 : creuser une question (nouvelles requêtes ou page suivante)
app.post('/api/dig-deeper', async (req, res) => {
  const { question, facts, current_queries, current_analysis, user_instruction, history = [] } = req.body;

  try {
    // Claude génère de nouvelles requêtes en tenant compte de ce qui a déjà été cherché
    const newQueriesRaw = await claude([{
      role: 'user',
      content: `Tu es un juriste français. On a déjà cherché ces requêtes JUDILIBRE : ${current_queries.join(', ')}.
L'instruction de l'utilisateur est : "${user_instruction}"
Question juridique : ${question.titre} — ${question.description}
Faits : ${facts}

Génère de NOUVELLES requêtes JUDILIBRE différentes des précédentes. JSON strict :
{
  "requetes_judilibre": ["nouvelle requête 1", "nouvelle requête 2"]
}`
    }], 300);

    let newQueries;
    try {
      newQueries = JSON.parse(newQueriesRaw.replace(/```json|```/g, '').trim());
    } catch(e) {
      newQueries = { requetes_judilibre: [] };
    }

    const jpResults = await searchJP(newQueries.requetes_judilibre, 0);

    const jpContext = jpResults.map(r =>
      `Requête "${r.query}" (${r.count} JP) :\n` +
      r.decisions.map((d, i) => `  [${i+1}] ${d.jurisdiction || ''} ${d.chamber || ''} ${d.date || ''} : ${d.fullText?.slice(0, 500) || d.excerpt}`).join('\n')
    ).join('\n\n');

    const messages = [
      ...history,
      {
        role: 'user',
        content: `En complément de l'analyse précédente, voici de nouvelles jurisprudences trouvées.
Instruction : ${user_instruction}

NOUVELLES JP :
${jpContext}

Analyse précédente :
${current_analysis}

Enrichis ou corrige l'analyse en tenant compte de ces nouvelles décisions.`
      }
    ];

    const analysis = await claude(messages, 2000);

    res.json({
      new_queries: newQueries.requetes_judilibre,
      jp_results: jpResults.map(r => ({
        query: r.query,
        count: r.count,
        total: r.total,
        decisions: r.decisions.map(d => ({
          id: d.id,
          date: d.date,
          jurisdiction: d.jurisdiction,
          chamber: d.chamber,
          solution: d.solution,
          permalink: d.permalink,
          excerpt: d.excerpt
        }))
      })),
      analysis
    });

  } catch(e) {
    console.error('dig-deeper error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat libre
app.post('/api/chat', async (req, res) => {
  const { message, history = [], context = '' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message manquant' });

  try {
    const messages = [
      { role: 'user', content: `Tu es un juriste français expert. Contexte de l'analyse en cours :\n${context}\n\nQuestion : ${message}` },
      ...history.slice(-6),
    ];
    const reply = await claude(messages, 1000);
    res.json({ reply });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Jurisxium running on port ${PORT}`);
  console.log(`ANTHROPIC_KEY: ${ANTHROPIC_KEY ? 'OK' : 'MANQUANTE'}`);
  console.log(`JUDILIBRE_KEY: ${JUDILIBRE_KEY ? 'OK' : 'MANQUANTE'}`);
  console.log(`OAUTH: ${OAUTH_CLIENT_ID ? 'OK' : 'MANQUANT'}`);
});
