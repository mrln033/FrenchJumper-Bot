# FrenchJumper Bot — Cloudflare Worker

Service HTTP du bot FrenchJumper, déployé sur Cloudflare Workers sans connexion
Discord Gateway permanente.

## Fonctions

- `GET /health` : état du service ;
- `GET /health/discord` : validation protégée du token Discord, sans mutation ;
- `POST /sync` : modification du surnom et ajout/retrait de rôles via l'API REST
  Discord ;
- `POST /webhooks/entropia-central` : réception HMAC et stockage idempotent dans
  D1 des livraisons Entropia.

## Secrets Cloudflare

Configurer les secrets sans les écrire dans Git :

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put ENTROPIA_CENTRAL_SIGNING_SECRET
```

`SYNC_TOKEN` est envoyé par l'appelant avec l'en-tête
`Authorization: Bearer <token>`. Définir `ALLOWED_GUILD_IDS` dans la configuration
ou dans le tableau de bord, sous forme d'identifiants séparés par des virgules.

## Déploiement

```powershell
npm install
npm test
npx wrangler d1 migrations apply frenchjumper-bot --remote
npm run deploy
```

## Production

- Worker : `frenchjumper-bot`
- Base D1 : `frenchjumper-bot`
- Compte Cloudflare : `enzo@frenchjumper.fr`

Le token Discord historique a été révoqué. Les secrets de production restent
exclusivement dans Cloudflare et ne doivent jamais être ajoutés au dépôt Git.
