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
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
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

// Évalue si les JP trouvées répondent à la question
async function evaluateJP(question, decisions) {
  if (!decisions.length) return { sufficient: false, reason: 'Aucune décision trouvée' };
  const sample = decisions.slice(0, 5).map((d, i) =>
    `[${i+1}] ${d.jurisdiction || ''} ${d.chamber || ''} ${d.date || ''} : ${d.fullText?.slice(0, 300) || d.excerpt || ''}`
  ).join('\n');
  const result = await claude([{
    role: 'user',
    content: `Question juridique : "${question.titre}" — ${question.description}

Voici des décisions trouvées :
${sample}

Ces décisions répondent-elles directement à la question posée ?
Réponds en JSON strict : {"sufficient": true/false, "reason": "explication courte", "relevant_indices": [1,2,3]}`
  }], 300);
  try {
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch(e) {
    return { sufficient: false, reason: 'Évaluation impossible' };
  }
}

// Recherche itérative avec SSE
async function iterativeJPSearch(question, facts, send, maxJP = 150) {
  // Génère les requêtes initiales
  const queriesRaw = await claude([{
    role: 'user',
    content: `Tu es un juriste français. Génère des requêtes de recherche JUDILIBRE pour cette question.
Question : "${question.titre}" — ${question.description}
Faits : ${facts}

Règles :
- 2 à 4 mots par requête (termes qui apparaissent dans les décisions, pas concepts abstraits)
- 3 à 6 requêtes, de la plus précise à la plus large
- Ordre : commence par les termes les plus spécifiques

JSON strict : {"requetes": ["requête 1", "requête 2", ...]}`
  }], 400);

  let queries;
  try {
    queries = JSON.parse(queriesRaw.replace(/```json|```/g, '').trim()).requetes;
  } catch(e) {
    queries = [question.titre.slice(0, 30)];
  }

  const allDecisions = [];
  const seenIds = new Set();
  let totalAnalyzed = 0;
  let sufficient = false;
  let queryIdx = 0;
  let page = 0;

  send({ type: 'queries', queries });

  while (totalAnalyzed < maxJP && !sufficient) {
    if (queryIdx >= queries.length) {
      // Génère de nouvelles requêtes
      send({ type: 'status', msg: 'Génération de nouvelles requêtes...' });
      const newQueriesRaw = await claude([{
        role: 'user',
        content: `On a cherché : ${queries.join(', ')} sans résultat suffisant.
Question : "${question.titre}"
Génère 3 nouvelles requêtes DIFFÉRENTES. JSON : {"requetes": ["req1","req2","req3"]}`
      }], 200);
      try {
        const newQ = JSON.parse(newQueriesRaw.replace(/```json|```/g, '').trim()).requetes;
        queries = [...queries, ...newQ];
        send({ type: 'new_queries', queries: newQ });
      } catch(e) { break; }
    }

    const q = queries[queryIdx];
    send({ type: 'searching', query: q, page });

    try {
      const data = await judilibre('search', { query: q, page_size: 10, page });
      const decisions = data.results || [];

      // Récupère texte complet
      const enriched = await Promise.all(
        decisions.filter(d => !seenIds.has(d.id)).map(async d => {
          seenIds.add(d.id);
          try {
            const full = await judilibre('decision', { id: d.id });
            return {
              ...d,
              fullText: (full.text || '').slice(0, 3000),
              permalink: d.permalink || `https://www.courdecassation.fr/decision/${d.id}`
            };
          } catch(e) {
            return { ...d, fullText: d.highlights?.text?.[0] || '', permalink: `https://www.courdecassation.fr/decision/${d.id}` };
          }
        })
      );

      allDecisions.push(...enriched);
      totalAnalyzed += enriched.length;
      send({ type: 'progress', total: totalAnalyzed, query: q, found: enriched.length });

      // Évalue tous les 10 JP si on en a assez
      if (totalAnalyzed >= 10 && totalAnalyzed % 10 === 0) {
        send({ type: 'evaluating', total: totalAnalyzed });
        const eval_ = await evaluateJP(question, allDecisions);
        if (eval_.sufficient) {
          sufficient = true;
          send({ type: 'sufficient', total: totalAnalyzed });
          break;
        }
      }

      // Page suivante ou requête suivante
      if (decisions.length < 10 || page >= 4) {
        queryIdx++;
        page = 0;
      } else {
        page++;
      }

    } catch(e) {
      queryIdx++;
      page = 0;
    }
  }

  return allDecisions;
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

// Qualification des faits
app.post('/api/qualify', async (req, res) => {
  const { facts } = req.body;
  if (!facts) return res.status(400).json({ error: 'Faits manquants' });

  try {
    const raw = await claude([{
      role: 'user',
      content: `Tu es un juriste français expert. Analyse ces faits et identifie les problèmes de droit.

RÈGLES ABSOLUES :
- Chaque question = UN problème de droit distinct avec sa propre règle juridique autonome
- Pas de recoupement entre questions : si deux questions ont la même règle de droit → fusionner
- Maximum 5 questions
- Formuler comme une vraie question juridique (pas un titre de cours)
- Chaque question doit pouvoir être résolue indépendamment des autres

JSON strict sans markdown :
{
  "resume_faits": "3-5 phrases, faits purs sans qualification juridique",
  "questions_droit": [
    {
      "id": 1,
      "titre": "Titre court",
      "description": "Question juridique précise à trancher",
      "branches": ["droit commercial"],
      "pertinence": "Pourquoi distincte des autres questions"
    }
  ]
}

Faits : ${facts}`
    }], 1500);

    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Analyse complète avec SSE (streaming)
app.get('/api/analyze-stream', async (req, res) => {
  const { facts, questions: questionsRaw } = req.query;
  if (!facts || !questionsRaw) return res.status(400).json({ error: 'Données manquantes' });

  const questions = JSON.parse(decodeURIComponent(questionsRaw));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const allResults = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      send({ type: 'question_start', idx: i, question: q });

      // Recherche JP itérative
      const decisions = await iterativeJPSearch(q, facts, send);

      // Recherche loi
      send({ type: 'status', msg: 'Recherche des textes de loi...' });
      const lois = await legifranceSearch(q.titre + ' ' + (q.branches?.[0] || ''));

      // Rédaction syllogisme
      send({ type: 'status', msg: 'Rédaction de l\'analyse juridique...' });

      const jpContext = decisions.slice(0, 20).map((d, idx) =>
        `[${idx+1}] ${d.jurisdiction || ''} ${d.chamber || ''} ${d.date || ''} (${d.permalink}) :\n${d.fullText?.slice(0, 1000) || d.excerpt || ''}`
      ).join('\n\n');

      const loiContext = lois.length
        ? 'TEXTES DE LOI :\n' + lois.map(l => `${l.titre || ''} : ${l.extract || ''}`).join('\n')
        : '';

      const analysis = await claude([{
        role: 'user',
        content: `Tu es un juriste français expert. Rédige l'analyse de cette question en syllogisme juridique strict.

QUESTION : "${q.titre}"
${q.description}

FAITS : ${facts}

${loiContext}

JURISPRUDENCE (${decisions.length} décisions analysées) :
${jpContext}

FORMAT OBLIGATOIRE — syllogisme :

**Majeure — La règle de droit**
La règle applicable, les articles de loi (avec numéros précis), et la jurisprudence pertinente. Pour chaque décision citée, intègre le lien directement après la citation : [Cass. com., 12 jan. 2020](URL). Ne cite que les décisions DIRECTEMENT pertinentes à cette question.

**Mineure — En l'espèce**
"En l'espèce," puis application aux faits concrets. Qualifie chaque élément factuel.

**Conclusion — Dès lors**
"Dès lors," puis réponse nette. Si la réponse n'est pas tranchée en jurisprudence, nuance et expose les deux positions.

RÈGLES :
- Cette question SEULEMENT, pas les autres
- Liens des décisions intégrés dans le texte, pas en section séparée
- Si JP insuffisante : le dire et raisonner sur les textes
- Pas d'introduction générale, pas de recommandations`
      }], 2500);

      allResults.push({ question: q, analysis, decisions_count: decisions.length, lois });
      send({ type: 'question_done', idx: i, analysis, decisions_count: decisions.length });
    }

    send({ type: 'done', results: allResults });
  } catch(e) {
    send({ type: 'error', message: e.message });
  }

  res.end();
});

// Chat libre
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
  console.log(`OAUTH: ${OAUTH_CLIENT_ID ? 'OK' : 'MANQUANT'}`);
});
