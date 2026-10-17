# Mettre Ronin.io en ligne avec Coolify

Ce guide décrit, écran par écran, la mise en ligne de Ronin.io sur le VPS (Hostinger, Ubuntu 24.04, IP
`187.77.173.33`) déjà équipé de **Coolify v4**, à l'adresse **https://ronin.apps.cr1ms0n.cloud**.

Principe : **un seul conteneur**. Le serveur Node (`dist-server/index.mjs`) sert à la fois la page du jeu
(le client construit, dans `/app/dist`) et le WebSocket du mode en ligne, sur **la même origine**. Le proxy
de Coolify (Traefik) reçoit le trafic sur 80/443, gère le certificat Let's Encrypt et transmet au conteneur
sur le port **2567**. Les autres sites du serveur ne sont pas touchés : on ajoute seulement une application.

Tout se fait dans votre navigateur (Coolify, GitHub, votre registraire DNS). Aucun mot de passe n'est à
transmettre à qui que ce soit.

> Les libellés cités sont ceux de Coolify v4. D'une version à l'autre (v4 beta 3xx à 4xx), certains
> changent un peu de nom ou de place ; les variantes connues sont indiquées entre parenthèses.

---

## 1. Prérequis

- Un accès administrateur au tableau de bord Coolify (par son domaine, ou `http://187.77.173.33:8000`).
- Le dépôt public **https://github.com/Sky273/Ronin**, branche `main`, contenant le `Dockerfile` à la racine.
- Un accès à la zone DNS de `cr1ms0n.cloud` (chez le registraire, ou chez Cloudflare si la zone y est).
- Un accès administrateur au dépôt GitHub (pour le webhook de redéploiement automatique).
- Le proxy de Coolify actif (**Servers → localhost → Proxy** : Traefik « Running »). C'est déjà le cas si
  d'autres sites du serveur fonctionnent en HTTPS.

Rien à installer sur votre PC : le build de l'image se fait sur le serveur.

---

## 2. DNS : faire pointer `ronin.apps.cr1ms0n.cloud` vers le serveur

### 2.1 Vérifier d'abord

Un enregistrement joker `*.apps.cr1ms0n.cloud` existe peut-être déjà. Dans **PowerShell** :

```powershell
Resolve-DnsName ronin.apps.cr1ms0n.cloud -Type A
nslookup ronin.apps.cr1ms0n.cloud 1.1.1.1
```

- La réponse donne `187.77.173.33` : le DNS est prêt, passez à l'étape 3.
- « Nom inexistant » / `NXDOMAIN`, ou une autre adresse : créez l'enregistrement ci-dessous.
- Une adresse Cloudflare (`104.x`, `172.67.x`…) : la zone est chez Cloudflare avec le proxy activé ;
  repassez l'enregistrement en « DNS only » (voir plus bas).

### 2.2 Créer l'enregistrement (si besoin)

Dans la zone DNS de `cr1ms0n.cloud` :

| Type | Nom (hôte)  | Valeur          | TTL |
|------|-------------|-----------------|-----|
| A    | `ronin.apps` | `187.77.173.33` | 300 |

- **Pas d'enregistrement AAAA** (IPv6) : s'il en existait un vers une autre machine, des visiteurs IPv6
  arriveraient ailleurs et Let's Encrypt pourrait échouer.
- **Cloudflare** : mettez le nuage en gris, **« DNS only »** (et non « Proxied »). Traefik doit recevoir
  directement les connexions pour obtenir son certificat Let's Encrypt.
- Selon le registraire, le champ « Nom » attend `ronin.apps` (relatif à la zone) ou le nom complet.

Attendez quelques minutes puis relancez les commandes de vérification ; ne continuez qu'une fois
`187.77.173.33` obtenu (sinon le certificat ne pourra pas être délivré).

---

## 3. Créer l'application dans Coolify

1. **Projects** → choisissez (ou créez avec **+ Add**) un projet, par exemple « Ronin ».
2. Ouvrez l'environnement **production**.
3. **+ New** (selon la version : **+ Add New Resource**).
4. Section « Git Based » : **Public Repository**.
5. Si Coolify le demande, choisissez le serveur **localhost** (celui où tourne Coolify) et la destination
   Docker par défaut.
6. **Repository URL** : `https://github.com/Sky273/Ronin` → **Check repository**.
7. Réglages proposés ensuite :
   - **Branch** : `main`
   - **Build Pack** : **Dockerfile** (par défaut Coolify propose *Nixpacks* : changez-le)
   - **Base Directory** : `/`
   - **Ports Exposes** : `2567`
8. **Continue**. Coolify ouvre la page de configuration de l'application. **Ne déployez pas encore.**

---

## 4. Onglet General (Configuration → General)

- **Name** : `ronin` (libre).
- **Domains** : remplacez l'adresse générée automatiquement (du type `http://xxxx.187.77.173.33.sslip.io`)
  par :

  ```
  https://ronin.apps.cr1ms0n.cloud
  ```

  Le préfixe **`https://`** est important : c'est lui qui fait demander un certificat Let's Encrypt à
  Traefik. Une seule adresse, sans `/` final.
- **Build Pack** : Dockerfile. **Dockerfile Location** : `/Dockerfile`. **Base Directory** : `/`.
- **Ports Exposes** : `2567`.
- **Ports Mappings** : **laisser vide**. Un mappage publierait le port 2567 directement sur l'IP du
  serveur, en contournant Traefik (pas de HTTPS, pas de contrôle d'origine fiable).
- **Force HTTPS** (dans la partie *Advanced* de la page, ou l'onglet **Advanced** selon la version) :
  **activé**. Les visiteurs en `http://` sont redirigés vers `https://`.

Cliquez sur **Save**.

---

## 5. Variables d'environnement (onglet Environment Variables)

L'image définit déjà les valeurs de production (`NODE_ENV=production`, `PORT=2567`, `STATIC_DIR=/app/dist`,
`TRUST_PROXY=1`, `MATCHMAKE_PER_MIN=20`, `MATCHMAKE_BURST=10`, `MAX_CONN_PER_IP=8`, `STATS_EVERY_MS=60000`,
`MAX_ROOMS=50`). Une seule variable est à ajouter :

| Variable          | Valeur                              |
|-------------------|-------------------------------------|
| `ALLOWED_ORIGINS` | `https://ronin.apps.cr1ms0n.cloud`  |

**+ Add** (ou mode **Developer view** pour coller `CLÉ=valeur`), puis **Save**.

- Ne cochez **pas** « Build Variable » (selon la version : « Is Build Variable? », ou décochez
  « Available at Buildtime » et gardez « Available at Runtime ») : la variable n'est lue qu'au démarrage
  du serveur.
- Elle limite le WebSocket aux pages servies depuis ce domaine (les autres sites ne peuvent pas y
  brancher leurs visiteurs). Plusieurs origines : séparées par des virgules.

Options (seulement si nécessaire ; sinon les valeurs de l'image s'appliquent) :

| Variable            | Défaut image | Rôle                                                              |
|---------------------|--------------|-------------------------------------------------------------------|
| `MATCHMAKE_PER_MIN` | 20           | Entrées en salle par minute et par IP (0 : illimité)              |
| `MATCHMAKE_BURST`   | 10           | Rafale d'entrées permise par IP                                   |
| `MAX_CONN_PER_IP`   | 8            | WebSocket simultanés par IP (à monter pour un lieu partageant une IP) |
| `MAX_ROOMS`         | 50           | Salles simultanées au plus (au-delà : « server full »)            |
| `STATS_EVERY_MS`    | 60000        | Période des lignes de mesures dans les journaux                   |

**À ne jamais définir** dans Coolify :

- `VITE_SERVER_URL` : le client se connecte tout seul à `wss://` sur le domaine de la page. Une valeur
  (surtout cochée « Build Variable ») figerait une autre adresse dans le client.
- `LAG_MS`, `JITTER_MS` : latence simulée, réservée aux tests ; en production elle dégraderait le jeu.
- `TRUST_PROXY` à autre chose que 1 : avec 0, tous les joueurs sembleraient venir de l'IP de Traefik et
  partageraient les mêmes limites.

---

## 6. Healthcheck (onglet Healthcheck)

L'image contient déjà un `HEALTHCHECK` équivalent ; le régler aussi dans Coolify rend son comportement
explicite (Coolify attend que le nouveau conteneur soit sain avant de basculer le trafic).

| Champ          | Valeur      |
|----------------|-------------|
| Enabled        | oui         |
| Method         | `GET`       |
| Scheme         | `http`      |
| Host           | `127.0.0.1` |
| Port           | `2567`      |
| Path           | `/health`   |
| Return Code    | `200`       |
| Interval (s)   | `30`        |
| Timeout (s)    | `5`         |
| Retries        | `3`         |
| Start Period (s) | `15`      |

**Save**. La sonde est lancée **dans le conteneur** (par `wget`, présent dans l'image Alpine).

---

## 7. Limites de ressources (onglet Resource Limits)

- **Number of CPUs** : `2`
- **Maximum Memory Limit** : `1g` (1 Gio ; selon la version le champ attend `1g`, `1024m` ou un nombre
  d'octets — l'aide du champ l'indique)
- Laissez les autres champs par défaut. **Save**.

Ces limites protègent les autres sites du serveur si une partie s'emballait.

---

## 8. Premier déploiement

Cliquez sur **Deploy** (en haut à droite). L'onglet **Deployments** (ou la fenêtre de journal qui s'ouvre)
montre le build. Repères attendus, dans l'ordre :

1. Clonage du dépôt, puis `Building docker image`.
2. Étape `build` : `npm ci`, `tsc --noEmit`, `vite build` (`✓ built in …`), puis `esbuild` du serveur.
   Un avertissement de Vite sur la taille d'un fichier (« chunks are larger than 500 kB ») est normal.
3. Étape d'exécution : `npm ci --omit=dev`.
4. Démarrage du conteneur, puis healthcheck : `healthy` (« New container is healthy » ou équivalent).
5. `Rolling update completed` / `Deployment finished`.

Le premier build prend quelques minutes. Dans l'onglet **Logs** de l'application (journaux du conteneur),
on doit lire :

```
[serveur] Ronin.io en écoute …
… statiques : N fichiers …
```

puis, toutes les 60 s, une ligne de mesures. Le certificat Let's Encrypt est obtenu à la première visite
(ou dans la minute) : la toute première requête HTTPS peut afficher un avertissement le temps qu'il arrive.

---

## 9. Déploiement automatique à chaque push sur `main`

Le dépôt étant public (pas d'application GitHub reliée), on utilise un **webhook manuel** avec secret.

### 9.1 Générer un secret (sur votre PC)

PowerShell :

```powershell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
```

ou, dans Git Bash / Linux :

```bash
openssl rand -hex 32
```

Gardez cette chaîne de 64 caractères sous la main, sans la publier.

### 9.2 Côté Coolify

1. Application → onglet **Webhooks** → section **Manual Git Webhooks**.
2. Champ **GitHub** (« GitHub Webhook Secret ») : collez le secret → **Save**.
3. Copiez l'**URL du webhook GitHub** affichée juste au-dessus. Deux cas :
   - Coolify a un domaine configuré (**Settings → Instance's Domain**) : l'URL ressemble à
     `https://<domaine-de-coolify>/webhooks/source/github/events/manual`. C'est le cas préférable.
   - Pas de domaine : l'URL est `http://187.77.173.33:8000/webhooks/source/github/events/manual`.
     GitHub doit alors pouvoir joindre le port 8000 : vérifiez que le pare-feu Hostinger (hPanel → VPS →
     Pare-feu) le laisse ouvert. Le secret protège l'appel, mais il passe en clair : le domaine en HTTPS
     reste préférable.
4. Onglet **Advanced** (ou **General → Advanced**) : **Auto Deploy** activé.

### 9.3 Côté GitHub

1. https://github.com/Sky273/Ronin → **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL** : l'URL copiée à l'étape précédente.
3. **Content type** : `application/json`.
4. **Secret** : le même secret.
5. **SSL verification** : activée (si l'URL est en `https://`).
6. **Which events…** : « Just the push event ».
7. **Active** coché → **Add webhook**.

GitHub envoie aussitôt un « ping » : dans le webhook → onglet **Recent Deliveries**, la ligne doit être
verte (réponse 200). Une croix rouge : ouvrez-la pour voir la réponse (URL erronée, port fermé, secret
différent).

---

## 10. Vérifications

Dans PowerShell (utilisez `curl.exe`, pas l'alias `curl` de PowerShell) :

```powershell
curl.exe -i https://ronin.apps.cr1ms0n.cloud/health
```

Attendu : `HTTP/2 200` (ou `HTTP/1.1 200`), `content-type: application/json` et un corps du type
`{"ok":true,"rooms":0,"players":0}`.

```powershell
curl.exe -I https://ronin.apps.cr1ms0n.cloud/
```

Attendu : `200`, `content-type: text/html`, et les en-têtes de sécurité envoyés par le serveur (par
exemple `content-security-policy`, `x-content-type-options: nosniff`).

```powershell
curl.exe -I http://ronin.apps.cr1ms0n.cloud/
```

Attendu : une redirection (`301`, `302` ou `308`) vers `https://ronin.apps.cr1ms0n.cloud/` (Force HTTPS).

Dans le navigateur :

1. Ouvrez https://ronin.apps.cr1ms0n.cloud : **cadenas** affiché, certificat émis par Let's Encrypt
   (cliquez sur le cadenas pour le voir) et non « TRAEFIK DEFAULT CERT ».
2. Ouvrez les outils de développement (F12) : onglet **Console** sans erreur rouge, notamment aucune
   violation de **Content-Security-Policy**.
3. Choisissez **Online** : la partie démarre. Onglet **Réseau** (Network), filtre **WS** : une connexion
   vers `wss://ronin.apps.cr1ms0n.cloud/…` avec le statut **101 Switching Protocols**.
4. Dans un **second navigateur** (ou une fenêtre de navigation privée), rejoignez aussi **Online** : les
   deux samouraïs se voient sur la même route. Faites de même avec **Dojo**.
5. Faites un petit push sur `main` (par exemple une faute de frappe corrigée dans un fichier texte) :
   un nouveau déploiement apparaît dans **Deployments** sans action de votre part, et le webhook est vert
   dans **Recent Deliveries**.

---

## 11. Dépannage

| Symptôme | Cause probable et remède |
|----------|--------------------------|
| Le navigateur signale un certificat **« TRAEFIK DEFAULT CERT »** | Let's Encrypt n'a pas pu délivrer le certificat : DNS pas encore propagé ou vers une autre IP, proxy Cloudflare actif (mettre « DNS only »), enregistrement AAAA parasite, port 80 fermé, ou `http://` au lieu de `https://` dans **Domains**. Corrigez, puis **Redeploy** (ou redémarrez le proxy). Voir les journaux du proxy (lignes `acme`). |
| Page blanche **« 404 page not found »** (texte brut de Traefik) | Traefik ne connaît aucun conteneur pour ce domaine : nom différent dans **Domains**, déploiement échoué, ou conteneur jugé **unhealthy** (Traefik écarte les conteneurs en mauvaise santé). Regardez **Deployments** et **Logs**, puis l'état du healthcheck. |
| **502 Bad Gateway** | Traefik joint le conteneur mais rien ne répond sur le port : **Ports Exposes** différent de `2567`, `PORT` modifié dans les variables, ou serveur planté au démarrage (voir **Logs**). |
| Le WebSocket est refusé (**403**, ou fermé tout de suite) | `ALLOWED_ORIGINS` ne correspond pas à l'adresse de la page : vérifiez `https://`, l'orthographe exacte du domaine, pas de `/` final ni d'espace. Après correction : **Restart** (ou **Redeploy**). |
| Erreur de **contenu mixte** (`ws://` bloqué depuis une page `https://`) | Une adresse de serveur a été figée dans le client : supprimez `VITE_SERVER_URL` des variables de Coolify, puis **Redeploy** (un rebuild est nécessaire). |
| Message **« too many requests »** | Limite de matchmaking par IP atteinte (`MATCHMAKE_PER_MIN` / `MATCHMAKE_BURST`), ou trop de connexions simultanées (`MAX_CONN_PER_IP`). Normal en cas d'abus ; pour un lieu où beaucoup de joueurs partagent une IP, montez ces valeurs. Vérifiez aussi que `TRUST_PROXY` vaut bien 1. |
| Message **« server full »** | Plafond de salles `MAX_ROOMS` atteint (ou salle pleine). Attendre, ou monter `MAX_ROOMS` si les ressources le permettent. |
| Message **« Version mismatch »** | La page en cache date d'avant une mise à jour du serveur : rechargez la page (Ctrl+F5). |
| Le webhook GitHub est rouge | Ouvrez la livraison dans **Recent Deliveries** : 401/403 = secret différent ; délai dépassé = URL injoignable (port 8000 fermé, mauvais domaine) ; 404 = URL mal copiée. |

**Journaux du proxy** (certificats, routage) : **Servers → localhost → Proxy → Logs** (selon la version,
l'onglet **Logs** de la page **Proxy**). Les journaux de l'application sont dans son onglet **Logs**, ceux
du build dans **Deployments**.

---

## 12. Mises à jour et retour arrière

### Mise à jour

Un push sur `main` (ou **Redeploy** à la main) construit une nouvelle image. Coolify démarre le nouveau
conteneur, attend qu'il soit sain, bascule le trafic, puis arrête l'ancien. À cet arrêt, les parties en
cours sont fermées proprement : les joueurs voient **« The server is restarting for an update — rejoin in
a few seconds. »** et n'ont qu'à rejoindre (ils arrivent sur la nouvelle version). Évitez de déployer
pendant un tournoi au dojo.

### Retour arrière

- **Rapide** : onglet **Rollback** de l'application → choisir une image précédente → **Rollback**.
  Attention : le prochain push sur `main` redéploiera la dernière version du dépôt.
- **Durable** : annuler le commit fautif dans le dépôt, puis pousser :

  ```bash
  git revert <commit>
  git push
  ```

  Le webhook redéploie automatiquement la version corrigée.

---

## 13. Sauvegardes

Rien à sauvegarder côté serveur : il ne stocke aucune donnée. Les meilleurs scores sont conservés dans le
navigateur de chaque joueur. Supprimer ou recréer l'application ne fait rien perdre ; il suffit de
refaire les réglages de ce guide.
