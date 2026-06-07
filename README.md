# Jurisxium — Proxy JUDILIBRE

Backend Express minimal qui proxifie l'API JUDILIBRE (PISTE / Cour de cassation) pour contourner CORS.

## Démarrage rapide

```bash
npm install
cp .env.example .env   # édite si besoin
npm start
```

Ouvre ensuite http://localhost:3000 pour le mini-testeur intégré.

## Routes disponibles

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/healthcheck` | Statut de l'API |
| GET | `/api/search?query=...&page=0&page_size=10` | Recherche plein texte |
| GET | `/api/decision/:id` | Décision par identifiant |
| GET | `/api/taxonomy?target=chamber` | Valeurs de filtres |
| GET | `/api/stats` | Statistiques globales |
| GET | `/api/export?query=...` | Export en lot |

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | 3000 | Port du serveur |
| `JUDILIBRE_KEY` | (ta clé) | Clé API PISTE |
| `JUDILIBRE_ENV` | production | `production` ou `sandbox` |

## Déploiement

- **Railway / Render / Fly.io** : `npm start` suffit, définis les env vars dans le dashboard
- **VPS** : utilise PM2 — `pm2 start server.js --name jurisxium`
