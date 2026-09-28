# FrenchJumper Bot — Cloudflare Worker

Service HTTP du bot FrenchJumper, déployé sur Cloudflare Workers sans connexion
Discord Gateway permanente.

## Documentation et suivi

La [description du projet et le suivi des tâches](_Description_Projet.txt) sont
versionnés dans ce dépôt et consultables sur GitHub par toute personne disposant
de l'accès au dépôt. Aucun secret ne doit être ajouté à cette documentation.

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

Le Cron `* * * * *` interroge la source chaque minute depuis le 28/09/2026.
La destination enregistrée dans le dashboard (D1) est prioritaire sur le salon
initial ci-dessus. Les webhooks Entropia Central existants restent indépendants.
Le relevé de référence à deux minutes et le protocole de comparaison figurent
dans [_Description_Projet.txt](_Description_Projet.txt), demande D-005.
Aucune Cloudflare Queue n'est utilisée par la relève.

Le Worker recharge le roster toutes les six heures et considère comme actif un
membre dont `niveau` est strictement supérieur à zéro. Les globals d'équipe sont
acceptés si leur nom contient `Frenchjumper` ou `FRJ`, sans distinction de casse,
même au milieu d'un mot. Ce filtre de nom ne vérifie pas les membres de l'équipe.
Ils suivent le même circuit anti-doublon et le même salon de comparaison, avec
un marqueur 👥. Aucun appel API ni stockage supplémentaire par équipe n'est ajouté.

Les noms provenant d'Entropia Central sont conservés tels quels. Les suffixes
d'items entre parenthèses, par exemple `(L)`, sont affichés dans Discord sans
barres obliques d'échappement, y compris lorsque le nom est cliquable.

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

## Administration privée (D-002)

Page : `https://frenchjumper-bot.enzo-488.workers.dev/admin`.

- Connexion OAuth2 Discord (`identify` uniquement), session d'une heure dans
  un cookie HttpOnly/Secure/SameSite=Lax ; jeton de session stocké haché dans D1.
- Accès par rôles sur le serveur FRJ, revérifiés à chaque requête. Le rôle
  initial `464513638414417930` reste autorisé comme secours. Les autres rôles
  se gèrent depuis la page. Chaque rôle autorisé obtient tous les droits du
  tableau de bord, y compris la gestion des autres rôles.
- Choix des salons texte/annonces où le bot possède Voir le salon, Envoyer des
  messages et Intégrer des liens. Aucun message de test n'est envoyé.
- Pause = lecture maintenue et nouveaux globals mis en attente ; reprise =
  publication de la file dans le salon courant (15 messages maximum par cycle).
  Les anciennes entrées `observed` ne sont pas rejouées automatiquement.
- Une modification pendant un cycle actif est refusée temporairement ;
  l'utilisateur doit réessayer. Les réglages sont versionnés contre l'écrasement
  d'une modification simultanée depuis une autre page.
- Actualisation des membres demandée au prochain Cron ; pas de rattrapage
  historique automatique. L'état et les quinze dernières entrées se rechargent
  manuellement, sans boucle de rafraîchissement.
- Une lecture D1 indexée supplémentaire par Cron pour les réglages, aucune
  Queue ajoutée. Les requêtes d'administration lisent aussi la session et les
  rôles ; elles ne sont pas gratuites en lectures. Pas de cache des droits.

Activation (application FrenchJumper, jamais PathFinder) :

1. Appliquer `migrations/0003_admin.sql` via Wrangler avant de déployer.
2. Discord Developer Portal → OAuth2 → Redirects : ajouter exactement
   `https://frenchjumper-bot.enzo-488.workers.dev/admin/callback`.
3. Cloudflare → Worker → Settings → Variables and Secrets : ajouter le secret
   `DISCORD_CLIENT_SECRET` avec le Client Secret OAuth2 (pas le Bot Token).
4. Vérifier la connexion avec un membre portant un rôle autorisé et un refus
   avec un membre sans rôle. Ne pas transmettre le secret dans la conversation.

Les réglages D1 prennent priorité sur les variables initiales de publication.
Déployer le code ne réinitialise pas les réglages. En secours, les rôles fixes
restent dans `ADMIN_ROLE_IDS` (configuration Wrangler). Les webhooks existants
et les secrets du bot ne sont jamais modifiés par l'interface.

Vérifications locales : `npm test` nécessite Node.js 24 (SQLite intégré pour
les tests), puis migrations D1 locales et `npm run deploy:dry`.

Références : [OAuth2 Discord](https://docs.discord.com/developers/topics/oauth2),
[permissions Discord](https://docs.discord.com/developers/topics/permissions).

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
