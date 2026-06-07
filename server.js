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
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, 'public')));

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

async function judilibre(endpoint, params = {}) {
  const url = new URL(JUDILIBRE_BASE + '/' + endpoint);
  Object.entries(params).forEach(function(e) {
    if (e[1] !== undefined && e[1] !== '') url.searchParams.set(e[0], e[1]);
  });
  const res = await fetch(url.toString(), {
    headers: { 'accept': 'application/json', 'KeyId': JUDILIBRE_KEY }
  });
  if (!res.ok) throw new Error('JUDILIBRE ' + res.status + ': ' + await res.text());
  return res.json();
}

async function legifranceSearch(query) {
  try {
    const token = await getOAuthToken();
    const res = await fetch(LEGIFRANCE_BASE + '/search', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
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

async function claude(messages, max_tokens) {
  if (!max_tokens) max_tokens = 3000;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY manquante');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: max_tokens, messages: messages })
  });
  const data = await res.json();
  if (data.type === 'error') throw new Error('Claude: ' + data.error.message);
  if (!data.content || !data.content[0]) throw new Error('Claude réponse vide');
  return data.content[0].text;
}

app.get('/api/healthcheck', async function(req, res) {
  try {
    const j = await judilibre('healthcheck');
    let lf = 'non testé';
    try { await getOAuthToken(); lf = 'ok'; } catch(e) { lf = 'erreur: ' + e.message; }
    res.json({ ok: true, judilibre: j, legifrance: lf });
  } catch(err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.post('/api/qualify', async function(req, res) {
  const facts = req.body.facts;
  if (!facts) return res.status(400).json({ error: 'Faits manquants' });
  try {
    const prompt = 'Tu es un juriste français expert. Analyse ces faits et identifie les problèmes de droit.\n\nREGLES :\n- Chaque question = UN problème de droit distinct avec sa propre règle juridique autonome\n- Pas de recoupement : si deux questions ont la même règle -> fusionner\n- Maximum 5 questions, minimum 2\n- Question = vraie question juridique à trancher\n\nJSON strict sans markdown :\n{"resume_faits": "3-5 phrases, faits purs","questions_droit": [{"id": 1,"titre": "Titre court","description": "Question précise","branches": ["droit commercial"]}]}\n\nFaits : ' + facts;
    const raw = await claude([{ role: 'user', content: prompt }], 1500);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/get-queries', async function(req, res) {
  const question = req.body.question;
  const facts = req.body.facts;
  try {
    const prompt = 'Juriste français. Génère des requêtes JUDILIBRE pour cette question juridique.\nQuestion : "' + question.titre + '" - ' + question.description + '\nFaits : ' + facts + '\n\nRegles :\n- 2-4 mots par requête, termes concrets qui apparaissent dans les décisions\n- 4 à 6 requêtes, de la plus spécifique à la plus large\n\nJSON strict : {"requetes": ["req1", "req2", ...]}';
    const raw = await claude([{ role: 'user', content: prompt }], 400);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/search-jp', async function(req, res) {
  const query = req.body.query;
  const page = req.body.page || 0;
  try {
    const data = await judilibre('search', { query: query, page_size: 10, page: page });
    const decisions = (data.results || []).map(function(d) {
      return {
        id: d.id,
        date: d.date || d.decision_date,
        jurisdiction: d.jurisdiction,
        chamber: d.chamber,
        solution: d.solution,
        permalink: d.permalink || ('https://www.courdecassation.fr/decision/' + d.id),
        excerpt: (d.highlights && d.highlights.text && d.highlights.text[0]) || (d.summary && d.summary.slice(0, 300)) || '',
        fullText: (d.highlights && d.highlights.text && d.highlights.text.join(' ')) || (d.summary && d.summary.slice(0, 500)) || ''
      };
    });
    res.json({ decisions: decisions, total: data.total || 0, has_more: decisions.length === 10 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/evaluate-jp', async function(req, res) {
  const question = req.body.question;
  const decisions = req.body.decisions;
  if (!decisions || !decisions.length) return res.json({ sufficient: false });
  try {
    const sample = decisions.slice(0, 8).map(function(d, i) {
      return '[' + (i+1) + '] ' + (d.jurisdiction||'') + ' ' + (d.chamber||'') + ' ' + (d.date||'') + ' : ' + (d.fullText ? d.fullText.slice(0, 400) : d.excerpt);
    }).join('\n');
    const prompt = 'Question : "' + question.titre + '" - ' + question.description + '\n\nDécisions trouvées :\n' + sample + '\n\nCes décisions répondent-elles directement à la question posée ?\nJSON strict : {"sufficient": true, "reason": "court"} ou {"sufficient": false, "reason": "court"}';
    const raw = await claude([{ role: 'user', content: prompt }], 200);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.json({ sufficient: false }); }
});

app.post('/api/new-queries', async function(req, res) {
  const question = req.body.question;
  const tried = req.body.tried_queries;
  try {
    const prompt = 'Question juridique : "' + question.titre + '"\nRequêtes déjà essayées sans résultat suffisant : ' + tried.join(', ') + '\nGénère 3 nouvelles requêtes DIFFERENTES pour JUDILIBRE (2-4 mots, termes concrets).\nJSON strict : {"requetes": ["req1","req2","req3"]}';
    const raw = await claude([{ role: 'user', content: prompt }], 200);
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/write-analysis', async function(req, res) {
  const question = req.body.question;
  const facts = req.body.facts;
  const decisions = req.body.decisions;
  const lois = req.body.lois;

  // Récupère texte complet des 8 meilleures décisions séquentiellement
  const decisionsSlice = decisions.slice(0, 8);
  const enriched = [];
  for (let i = 0; i < decisionsSlice.length; i++) {
    const d = decisionsSlice[i];
    try {
      const full = await judilibre('decision', { id: d.id });
      enriched.push(Object.assign({}, d, { fullText: (full.text || '').slice(0, 2000) }));
    } catch(e) {
      enriched.push(Object.assign({}, d, { fullText: d.excerpt || '' }));
    }
  }

  const jpLines = enriched.map(function(d, i) {
    return '[' + (i+1) + '] ' + (d.jurisdiction||'') + ' ' + (d.chamber||'') + ' ' + (d.date||'') + ' (' + d.permalink + ') :\n' + (d.fullText || d.excerpt);
  });
  const jpContext = jpLines.join('\n\n');

  const loiContext = (lois && lois.length)
    ? 'TEXTES DE LOI :\n' + lois.map(function(l) { return (l.titre||'') + ' : ' + (l.extract||''); }).join('\n')
    : '';

  const prompt = 'Tu es un juriste français expert. Rédige l\'analyse de cette seule question en syllogisme juridique.\n\nQUESTION : "' + question.titre + '"\n' + question.description + '\n\nFAITS : ' + facts + '\n\n' + loiContext + '\n\nJURISPRUDENCE (' + decisions.length + ' décisions analysées) :\n' + jpContext + '\n\nFORMAT OBLIGATOIRE :\n\n## Majeure — La règle de droit\nRègle applicable : articles de loi (numéros précis) et jurisprudence. Pour chaque décision citée, intègre le lien : [Cass. com., 12 jan. 2020](URL). Ne cite que les décisions DIRECTEMENT pertinentes.\n\n## Mineure — En l\'espèce\n"En l\'espèce," puis qualification des faits concrets par rapport à la règle.\n\n## Conclusion — Dès lors\n"Dès lors," puis réponse nette. Si jurisprudence contradictoire ou insuffisante : nuance les deux positions clairement.\n\nREGLES :\n- Cette question UNIQUEMENT\n- Liens des décisions intégrés dans le texte\n- Si JP insuffisante : raisonner sur les textes et le dire\n- Pas d\'introduction ni de recommandations';

  try {
    const analysis = await claude([{ role: 'user', content: prompt }], 2500);
    res.json({ analysis: analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', async function(req, res) {
  const message = req.body.message;
  const history = req.body.history || [];
  const context = req.body.context || '';
  try {
    const messages = [{ role: 'user', content: 'Tu es un juriste français expert.\nContexte : ' + context + '\n\nQuestion : ' + message }].concat(history.slice(-6));
    const reply = await claude(messages, 1000);
    res.json({ reply: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claude-direct', async function(req, res) {
  const prompt = req.body.prompt;
  const max_tokens = req.body.max_tokens || 1200;
  if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
  try {
    const text = await claude([{ role: 'user', content: prompt }], max_tokens);
    console.log('CLAUDE-DIRECT RAW:', text.slice(0, 500));  // ← ligne ajoutée
    res.json({ text: text });
  } catch(e) { 
    console.log('CLAUDE-DIRECT ERROR:', e.message);  // ← ligne ajoutée
    res.status(500).json({ error: e.message }); 
  }
});
app.listen(PORT, function() {
  console.log('Jurisxium running on port ' + PORT);
  console.log('ANTHROPIC_KEY: ' + (ANTHROPIC_KEY ? 'OK' : 'MANQUANTE'));
  console.log('JUDILIBRE_KEY: ' + (JUDILIBRE_KEY ? 'OK' : 'MANQUANTE'));
});
