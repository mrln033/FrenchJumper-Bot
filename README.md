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
- `GET /health/entropia` : état protégé du lecteur de globals ;
- `POST /admin/entropia/poll` : exécution manuelle protégée du lecteur pour les
  tests et diagnostics.

## Globals Entropia Central

Le lecteur automatique fonctionne indépendamment des notifications existantes
d'Entropia Central. Il récupère la liste officielle des membres actifs, parcourt
l'API publique Entropia Central avec pagination, conserve uniquement les
avatars actifs et publie les nouveaux globals dans Discord avec anti-doublon D1.

Le mode comparaison est activé :

```text
ENTROPIA_POLLING_ENABLED=true
ENTROPIA_PUBLISH_ENABLED=true
ENTROPIA_DISCORD_CHANNEL_ID=1553100694503034940
```

Le Cron `*/2 * * * *` interroge la source toutes les deux minutes et les
publications visent le salon temporaire ci-dessus. Les notifications Entropia Central existantes peuvent
continuer à publier dans leur salon habituel pendant toute la validation.

Le Worker recharge le roster toutes les six heures et considère comme actif un
membre dont `niveau` est strictement supérieur à zéro. Les globals d'équipe sont
acceptés si leur nom contient `Frenchjumper` ou `FRJ`, sans distinction de casse,
même au milieu d'un mot. Ce filtre de nom ne vérifie pas les membres de l'équipe.
Ils suivent le même circuit anti-doublon et le même salon de comparaison, avec
un marqueur 👥. Aucun appel API ni stockage supplémentaire par équipe n'est ajouté.

## Couleurs des catégories

Couleurs des encarts, indépendantes de Global / HoF / ATH :

| Catégorie | Couleur |
| --- | --- |
| Hunting | Rouge-orangé `#FF5733` |
| Mining | Bleu `#3498DB` |
| Construction | Jaune `#FFB900` |
| Killing Spree | Rouge sombre `#C0392B` |
| New Items | Vert `#2ECC71` |
| Reached Item Tiers | Violet `#9B59B6` |
| Rare Items | Rose `#E84393` |
| Kill as Creature | Brun `#A66E3F` |
| Space Mining | Indigo `#5865F2` |
| Fishing | Turquoise `#1ABC9C` |

Reconnaissance insensible à la casse ; alias API `PvP`, `Discovery`,
`Tiered Item`, `Rare item` acceptés. Catégorie inconnue : gris `#95A5A6`.

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

Avant la première activation du lecteur :

```powershell
npx wrangler d1 migrations apply frenchjumper-bot --remote
```

Après activation, son état peut être contrôlé avec un bearer `SYNC_TOKEN` sur
`GET /health/entropia`.

## Production

- Worker : `frenchjumper-bot`
- Base D1 : `frenchjumper-bot`
- Compte Cloudflare : `enzo@frenchjumper.fr`

Le token Discord historique a été révoqué. Les secrets de production restent
exclusivement dans Cloudflare et ne doivent jamais être ajoutés au dépôt Git.
