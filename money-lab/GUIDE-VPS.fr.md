# Lancer Money Lab sur un serveur (VPS) — guide pas à pas

Guide opérateur (en français). Aucune étape ne doit être faite par le bot lui-même.
Les prix et menus des sites cités changent : vérifie-les au moment de t'inscrire.

**Ce qu'il te faut :** une carte bancaire, environ 20 €, ton téléphone avec Telegram, un ordinateur.

> Pour toutes les commandes : copie-colle une ligne, appuie sur **Entrée**, attends la fin avant la
> suivante. Si une ligne affiche une erreur en rouge, arrête-toi et envoie le message (sans clé ni mot de passe).

---

## Étape 1 — Le « cerveau » : compte Anthropic

1. Va sur https://console.anthropic.com et crée un compte.
2. **Billing / Facturation** : ajoute des crédits (par exemple 15 $).
3. **Limits / Limites** : fixe une limite de dépense mensuelle (par exemple 15 $). C'est ta protection
   ultime : même en cas de bug, Anthropic ne facturera pas au-delà.
4. **API Keys** : crée une clé. Elle commence par `sk-ant-`. Copie-la dans un endroit sûr
   (tu ne pourras plus la revoir). **Ne la donne à personne, ni dans un chat.**

## Étape 2 — Ton canal : Telegram

1. Dans Telegram, cherche **@BotFather**, envoie `/newbot`, choisis un nom (ex : `Money Lab de Malik`)
   et un identifiant finissant par `bot`. BotFather te donne un **token** : garde-le secret.
2. Cherche **@userinfobot**, envoie-lui un message : il te répond ton **Id** (un nombre). C'est ton
   « chat id ».
3. Ouvre la conversation avec **ton** nouveau bot et appuie sur **Démarrer** (sinon il ne pourra pas t'écrire).

## Étape 3 — Les revenus : Stripe (tu peux le faire plus tard)

1. Crée un compte sur https://stripe.com (vérification d'identité demandée par Stripe).
2. **Développeurs → Clés API → Créer une clé restreinte** : donne uniquement l'accès en **lecture** au
   **solde / transactions du solde (Balance)**. La clé commence par `rk_`.
3. Pas encore prêt ? Saute cette étape et ajoute `--no-stripe` à l'étape 7.

## Étape 4 — Louer le serveur (VPS)

1. Chez un hébergeur (Hetzner, OVH, Scaleway…), loue le plus petit VPS avec **Ubuntu 24.04**
   et **au moins 2 Go de mémoire**. Note son **adresse IP** et son **mot de passe root** (ou ta clé SSH).
2. Note aussi son **prix mensuel** : il compte dans les dépenses du bot (étape 7).

## Étape 5 — Se connecter au serveur

Sur ton ordinateur, ouvre **Terminal** (Mac) ou **PowerShell** (Windows), puis :
```sh
ssh root@ADRESSE_IP
```
Tape `yes` si on te le demande, puis le mot de passe. Tu es « dans » le serveur.

## Étape 6 — Préparer et installer

Colle ces blocs l'un après l'autre :
```sh
apt update && apt -y upgrade
apt -y install git curl ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node --version
```
La dernière ligne doit afficher `v22…`.

```sh
ufw allow OpenSSH && ufw --force enable
useradd --create-home --shell /bin/bash moneylab
git clone https://github.com/moneylab-djib/Money-lab /opt/money-lab
chown -R moneylab:moneylab /opt/money-lab
corepack enable pnpm
cd /opt/money-lab
sudo -u moneylab -H pnpm install --frozen-lockfile
sudo -u moneylab -H pnpm run build
```

## Étape 7 — Configurer

Remplace `123456789` par ton chat id (étape 2), `6` par le prix mensuel du VPS en dollars,
`1.08` par le taux euro→dollar du jour (cherche « EUR USD » sur internet) et `2` par le budget
d'inférence maximum par jour en dollars :
```sh
cd /opt/money-lab
sudo -u moneylab -H node money-lab/vps/configure.mjs --chat-id 123456789 --vps-cost-per-month 6 --eur-usd 1.08 --daily-budget 2
```
Tu dois voir `Configuration Money Lab écrite`.

Ensuite, le fichier des secrets (lisible uniquement par l'administrateur, **pas par le bot**) :
```sh
cp money-lab/vps/money-lab.env.example /etc/money-lab.env
chown root:root /etc/money-lab.env && chmod 600 /etc/money-lab.env
nano /etc/money-lab.env
```
Dans l'éditeur, remplace les `REPLACE_ME` par ta clé Anthropic, ton token Telegram et ta clé Stripe
(ou laisse `STRIPE_API_KEY=` vide). Enregistre avec **Ctrl+O**, **Entrée**, puis quitte avec **Ctrl+X**.

## Étape 8 — Donner son budget au bot

Le solde du bot = ce que tu lui donnes. Mets le même montant que tes crédits Anthropic, en **centimes
de dollar** (15 $ → `1500`) :
```sh
sudo -u moneylab -H node dist/index.js --money-lab ledger-add owner_funding 1500 depot-initial
sudo -u moneylab -H node dist/index.js --money-lab status
```
Le statut doit montrer **Solde : 15.00 USD**. Plus tard, tu pourras ajouter des fonds depuis Telegram
avec `/fonds 10`.

## Étape 9 — Démarrer le bot (24 h/24)

```sh
cp money-lab/vps/money-lab.service /etc/systemd/system/money-lab.service
systemctl daemon-reload
systemctl enable --now money-lab
journalctl -u money-lab -f
```
La dernière commande affiche ce que fait le bot en direct (**Ctrl+C** pour arrêter de regarder ; le bot
continue). Il redémarre tout seul en cas de plantage ou de redémarrage du serveur.

## Étape 10 — Lui parler sur Telegram

Envoie `/aide` à ton bot. Commandes principales :

| Commande | Effet |
| --- | --- |
| `/statut` | solde, jours restants, expériences, demandes, finances |
| `/sante` | rapport de santé : verdict (✅ tout va bien, ⚠️ à surveiller, 🚨 problème), activité et erreurs des dernières 24 h, dépense, idées, disque, sauvegarde. Envoyé aussi automatiquement chaque matin (vers 9 h l'été, 8 h l'hiver) |
| `/plafond 5` ou `/plafond 5 1.5` | change le plafond de dépense IA : 5 $ par jour (et 1,50 $ par heure si tu donnes le 2e montant ; sinon le plafond par heure actuel est gardé). Le bot répond avec l'avant/après puis redémarre tout seul (environ 30 secondes). Maximum 100 $ par jour depuis Telegram ; le plafond par heure ne peut pas dépasser celui par jour |
| `/resume` | résumé détaillé (budget, expériences, finances) |
| `/aides` | ce que le bot te demande |
| `/ok <id> [note]` / `/non <id> [raison]` | répondre à une demande |
| `/fonds 10` | ajouter 10 $ à son solde (ajoute aussi les crédits sur Anthropic !) |
| `/revenu 12 vente-1` | confirmer un revenu hors Stripe |
| `/pause [raison]` / `/reprendre` | arrêter / relancer ses dépenses |
| tout autre message | transmis au bot comme une conversation |

## Mettre à jour le bot

Quand une correction est publiée sur GitHub :
```sh
cd /opt/money-lab
sudo -u moneylab -H git pull
sudo -u moneylab -H pnpm install --frozen-lockfile
sudo -u moneylab -H pnpm run build
systemctl restart money-lab
```
La pause (`/pause`) est conservée après le redémarrage : relance avec `/reprendre` quand tu es prêt.

**Une seule fois** (mise à jour d'octobre 2026, protection des clés) : installe le nouveau fichier de
service, qui démarre le programme puis le fait passer aussitôt sous l'utilisateur `moneylab`. Ainsi
les commandes du bot ne peuvent plus lire la clé Anthropic ni le jeton Telegram dans la mémoire du
programme :
```sh
cp /opt/money-lab/money-lab/vps/money-lab.service /etc/systemd/system/money-lab.service
systemctl daemon-reload
systemctl restart money-lab
ps -o user= -p $(systemctl show -p MainPID --value money-lab)
```
La dernière commande doit afficher `moneylab`. Tant que ce n'est pas fait, le bot t'envoie chaque
jour « 🔐 Protection des clés inactive » sur Telegram.

## Lui écrire

Tout message Telegram qui n'est pas une commande lui est transmis comme venant de toi et le réveille
(compte jusqu'à environ 40 secondes). Quand il n'a rien à faire, il dort 15 minutes entre deux réveils.
Ses serveurs s'arrêtent à chaque redémarrage du service : il les relance via `~/autostart.sh`.

## Quand le bot veut publier un site

Rien de ce que le bot lance n'est visible sur internet tant que tu ne l'ouvres pas. S'il te le demande
(par exemple pour le port 8080) et que tu es d'accord :
```sh
ufw allow 8080/tcp
```
Le site sera alors visible à `http://ADRESSE_IP:8080`. Pour le refermer : `ufw delete allow 8080/tcp`.

## Donner des mains et des yeux au bot

Ces accès le rendent autonome : il publie, lit ses statistiques, regarde ses pages et cherche sur le web.

1. **Outils sur le serveur** (en root) :
   ```sh
   apt -y install gh poppler-utils
   wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
   apt -y install ./google-chrome-stable_current_amd64.deb && rm google-chrome-stable_current_amd64.deb
   ```
2. **Son organisation GitHub** : sur github.com, « + » → *New organization* → plan *Free*, à ton nom.
   Transfère-y ses dépôts (*Settings → Transfer*). Puis *Settings → Developer settings → Fine-grained
   tokens → Generate* : *Resource owner* = l'organisation, *All repositories*, permissions
   *Administration*, *Contents*, *Pages* en *Read and write*, expiration 90 jours.
3. **GoatCounter** : *Settings → API* → nouveau jeton avec *Read statistics* uniquement.
4. Ajoute dans `/etc/money-lab.env` (`nano /etc/money-lab.env`) : `GH_TOKEN=…`, `GITHUB_ORG=…`,
   `GOATCOUNTER_SITE=…`, `GOATCOUNTER_TOKEN=…`, puis `systemctl restart money-lab`.

Ces deux jetons sont **lisibles par le bot** (c'est voulu) : limite-les comme indiqué. Le pire qu'il
puisse faire avec, c'est modifier ses propres dépôts ou lire ses propres statistiques.

5. **Google Search Console** (facultatif, lecture seule) : sur https://console.cloud.google.com, crée un
   projet, active l'API *Google Search Console API*, puis *IAM → Comptes de service → Créer* (aucun
   rôle) → onglet *Clés* → *Ajouter une clé → JSON* (un fichier se télécharge). Dans Search Console,
   *Paramètres → Utilisateurs et autorisations → Ajouter* : l'adresse du compte de service
   (`...@...iam.gserviceaccount.com`), autorisation *Restreint*. Copie le fichier sur le serveur sans
   l'afficher : `scp fichier.json root@IP:/home/moneylab/.automaton/gsc-key.json`, puis en root
   `chown moneylab: /home/moneylab/.automaton/gsc-key.json && chmod 600 /home/moneylab/.automaton/gsc-key.json`.
   Ajoute `GSC_SITE=https://ton-site/` (l'adresse exacte de la propriété) dans `/etc/money-lab.env` et
   redémarre. Ce fichier est protégé : le bot ne peut pas le lire avec ses outils, seul le programme s'en sert.

6. **Bluesky** (quand le bot aura quelque chose à montrer) : crée un compte sur https://bsky.app avec une
   adresse e-mail à toi, puis *Paramètres → Confidentialité et sécurité → Mots de passe d'application →
   Ajouter*. Mets dans `/etc/money-lab.env` : `BLUESKY_HANDLE=ton-compte.bsky.social` et
   `BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx`, puis redémarre. Le bot ne voit pas ce mot de passe. Chaque
   publication t'arrive sur Telegram : `/publier <id>` ou `/rejeter <id> [raison]`.
7. **IA gratuites : la rotation** (conseillé, gratuit) : le bot confie la lecture des pages, l'extraction
   des données, les résumés et les relectures à des IA gratuites, et garde Claude pour réfléchir et Opus
   pour décider. Il tourne entre les fournisseurs dans la limite du quota gratuit de chacun, compte ses
   requêtes par jour et s'arrête avant la limite ; sans aucune clé, il utilise Claude Haiku (payant).
   Crée une clé chez chaque fournisseur que tu acceptes, avec un compte à toi, et garde-la dans un fichier
   texte sur ton ordinateur (jamais dans un chat). Les trois premiers suffisent pour commencer :
   - **Google Gemini** (le plus généreux, gros contexte) : https://aistudio.google.com/apikey → *Create API
     key*. Variable `GEMINI_API_KEY` (commence par `AIza`). Sur l'offre gratuite, Google peut utiliser ce
     qui lui est envoyé pour améliorer ses produits : le bot n'y envoie que des pages publiques.
   - **Mistral** (1 milliard de tokens par mois, en France) : https://console.mistral.ai → crée un compte
     → *Billing* → choisis le plan **Experiment** (gratuit ; il demande de vérifier un numéro de téléphone
     et d'accepter que les données servent à l'entraînement) → *API Keys* → *Create new key*. Variable
     `MISTRAL_API_KEY`.
   - **Groq** (très rapide) : https://console.groq.com → *API Keys* → *Create API Key*. Variable
     `GROQ_API_KEY` (commence par `gsk_`).
   - **NVIDIA NIM** (plus de 100 grands modèles ouverts) : https://build.nvidia.com → *Join* avec une
     adresse e-mail → sur la page d'un modèle, *Get API Key*. Variable `NVIDIA_API_KEY` (commence par `nvapi-`).
   - **SambaNova Cloud** : https://cloud.sambanova.ai → compte → *API Keys*. Variable `SAMBANOVA_API_KEY`.
   - **GitHub Models** (GPT-4o mini, Llama, Codestral ; bon pour le code) : https://github.com/settings/tokens
     → *Generate new token (classic)* → coche uniquement `models:read` (ou aucun droit si la case n'existe
     pas) → *Generate*. Variable `GITHUB_MODELS_TOKEN`. Prends un jeton différent de celui du bot (`GH_TOKEN`).
   - **Cloudflare Workers AI** (10 000 « neurones » par jour) : https://dash.cloudflare.com → compte
     gratuit → *AI → Workers AI → Use REST API* → *Create a Workers AI API Token*. Variables
     `CLOUDFLARE_AI_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` (l'identifiant de compte est affiché sur la même page).
   - **OpenRouter** (facultatif) : https://openrouter.ai → *Keys* → *Create Key*. Variable `OPENROUTER_API_KEY`
     (commence par `sk-or-`). Le programme n'utilise que les modèles gratuits (nom finissant par `:free`).

   Ajoute ensuite dans `/etc/money-lab.env` une ligne par clé, par exemple `GEMINI_API_KEY=AIza…`, puis
   `systemctl restart money-lab`. Le journal affiche alors « IA gratuites pour la récolte : groq, gemini,
   mistral… ». Le bot ne voit pas ces clés. Si l'une est refusée, tu reçois un message Telegram et le
   rapport de santé l'indique ; `/sante` montre aussi combien de requêtes gratuites il a faites par jour.

   **IA sur ton serveur (Ollama, facultatif)** : gratuite et illimitée, mais lente sans carte graphique
   (une à trois minutes par lecture). Vérifie d'abord la mémoire avec `free -h` : il faut au moins 4 Go
   (colonne *total*) pour un petit modèle, 8 Go pour un modèle moyen. Puis, en root :
   ```sh
   curl -fsSL https://ollama.com/install.sh | sh
   ollama pull qwen2.5:3b        # 4 à 8 Go de mémoire ; qwen2.5:7b avec 8 Go ou plus
   systemctl restart money-lab
   ```
   Ollama n'écoute que sur le serveur lui-même (127.0.0.1). Le bot s'en sert après les IA en ligne.

   **Modes de travail** : le programme déduit un mode du journal du bot et plafonne ses tours payants en
   conséquence. *Découverte* (recherche de niches, sur les IA gratuites) : 1 $ par jour et 0,40 $ par
   heure au maximum, modifiables avec `MONEY_LAB_DISCOVERY_DAILY_CENTS` et
   `MONEY_LAB_DISCOVERY_HOURLY_CENTS` dans `/etc/money-lab.env` (en centimes). *Construction* (une
   expérience a le statut « building ») : tes plafonds de `/plafond`. *Observation* (rien à construire,
   idées notées) : il peut dormir 24 h, et seuls les contrôles gratuits (sites, tâches planifiées) ou toi
   le réveillent. `/sante` et `/statut` indiquent le mode en cours.
8. **Nom de domaine** (quand le bot le demande) : achète le nom qu'il propose chez OVH (*Noms de domaine →
   Commander*), puis dans *Zone DNS* ajoute les enregistrements qu'il t'indique (4 lignes A vers
   185.199.108.153 à 185.199.111.153, et `www` en CNAME vers son organisation GitHub). Réponds `/ok <id>`
   à sa demande : il termine la configuration lui-même.

La recherche web payante d'Anthropic (environ 1 centime par recherche, plus les pages lues au prix du bot) est
active tant qu'il n'a rien de gratuit à la place. Dès que `TAVILY_API_KEY` est renseignée, la recherche
payante est coupée (il cherche avec `free_search`) ; dès qu'une IA gratuite est configurée, la lecture
payante de pages est coupée aussi (il lit avec `harvest` et `delegate`, gratuits). La règle est vérifiée à
chaque requête : si Tavily a épuisé son quota du jour ou refuse la clé, ou si toutes les IA gratuites sont au
repos, l'outil payant revient le temps que le gratuit soit de nouveau disponible. Le journal l'indique au
démarrage (« Outils web payants : web_search coupé, web_fetch coupé »). Pour forcer :
`MONEY_LAB_WEB_TOOLS=anthropic` dans `/etc/money-lab.env` ; pour tout couper : `MONEY_LAB_WEB_TOOLS=off`.

## Comptes gratuits qui augmentent le bot (facultatifs, un par un)

Chaque compte ci-dessous est gratuit sans carte bancaire et ajoute une capacité précise. Crée-les à ton
rythme, dans l'ordre qui t'arrange ; le bot découvre chaque clé au redémarrage et le journal affiche
« Services gratuits configurés : … ». Toutes ces clés sont **invisibles pour le bot** : seul le programme
s'en sert, avec un plafond d'appels par jour inférieur au quota gratuit. Pour chacune : crée la clé sur le
site, ajoute la ligne dans `/etc/money-lab.env` (`nano /etc/money-lab.env`), puis `systemctl restart money-lab`.
Ne colle jamais une clé dans un chat.

1. **Tavily** — recherche web gratuite pour ses recherches (remplace la recherche payante d'Anthropic,
   1 000 recherches par mois ; le bot s'en autorise 30 par jour). https://app.tavily.com → compte avec ton
   e-mail → *API Keys* → *Create*. Variable `TAVILY_API_KEY` (commence par `tvly-`).
2. **Bing Webmaster Tools** — ce que Bing (et donc DuckDuckGo, Ecosia, Copilot) montre de ses sites, et
   l'envoi de nouvelles pages à indexer en quelques heures. https://www.bing.com/webmasters → connexion avec
   un compte Microsoft → *Ajouter un site* (le plus simple : *Importer depuis Google Search Console*) →
   roue dentée *Paramètres → Accès API → Générer une clé API*. Variable `BING_WEBMASTER_KEY`.
3. **INSEE Sirene** — combien d'entreprises existent dans un métier et une zone (taille d'un marché local,
   concurrence). https://portail-api.insee.fr → compte → *Mes applications → Créer une application* →
   souscrire à l'API *Sirene* → copie la clé (*Clé d'intégration*). Variable `INSEE_API_KEY`.
4. **Légifrance via PISTE** — vérifier ce qu'un produit ou une promesse doit respecter (codes, lois, décrets,
   jurisprudence). https://piste.gouv.fr → compte → *Applications → Créer* → coche l'API *Légifrance* →
   accepte ses conditions (quelques heures d'attente) → *Identifiants client* (production ou sandbox).
   Variables `PISTE_CLIENT_ID` et `PISTE_CLIENT_SECRET` (et `PISTE_SANDBOX=1` si tu n'as que le bac à sable).
5. **dev.to** — pour les articles « comment j'ai construit… » en anglais, publiés par le programme après ton
   `/publie <id>` (rien à coller). https://dev.to → compte → *Settings → Extensions → DEV Community API Keys
   → Generate*. Variable `DEVTO_API_KEY`.
6. **Mastodon** — un compte à lui pour partager ses outils (francophone : https://piaille.fr ou
   https://mamot.fr ; anglophone : https://mastodon.social). Crée le compte avec une adresse e-mail à toi,
   puis *Préférences → Développement → Nouvelle application* : nom « Money Lab », coche uniquement
   `write:statuses` → *Envoyer* → copie *Votre jeton d'accès*. Variables `MASTODON_INSTANCE=piaille.fr` et
   `MASTODON_TOKEN`. Les kits pour Mastodon sont publiés par le programme après ton `/publie <id>`.
7. **Resend** — il t'envoie par e-mail les rapports trop longs pour Telegram (3 par jour). https://resend.com
   → compte → *API Keys → Create* (permission *Sending access*). Variables `RESEND_API_KEY` (commence par
   `re_`) et `MONEY_LAB_OWNER_EMAIL=ton adresse` (sans domaine vérifié, Resend n'envoie qu'à l'adresse de ton
   compte, ce qui est exactement ce qu'il faut).
8. **UptimeRobot** — une surveillance externe de ses sites toutes les 5 minutes, en plus de la sienne
   (50 moniteurs gratuits). https://uptimerobot.com → compte → *Integrations & API → Main API key → Create*.
   Variable `UPTIMEROBOT_API_KEY`.
9. **Cloudflare Pages et Workers** — un second hébergement gratuit (`<nom>.pages.dev`, bande passante
   illimitée, 500 déploiements par mois) avec l'outil `deploy_site`, et des petits serveurs gratuits
   (`<nom>.<compte>.workers.dev`, 100 000 requêtes par jour, stockage KV ou base D1) avec l'outil
   `deploy_worker` : formulaires, compteurs, listes d'attente, petites API joignables depuis internet sans
   rien ouvrir sur ton serveur. Le programme lit aussi les statistiques Web Analytics (`web_analytics`).
   Sur https://dash.cloudflare.com (le compte des IA gratuites convient) : *Profil → API Tokens → Create
   Token → Custom token*, nom « Money Lab Cloudflare », permissions (toutes sur *Account*, uniquement ton
   compte) :
   - *Cloudflare Pages → Edit*
   - *Workers Scripts → Edit*
   - *Workers KV Storage → Edit*
   - *D1 → Edit*
   - *Account Analytics → Read*
   - *Account Settings → Read*

   Si tu as déjà créé un jeton « Pages » seul, ouvre-le dans la liste (*Edit*) et ajoute les cinq autres
   lignes : la valeur du jeton ne change pas. Variable `CLOUDFLARE_PAGES_TOKEN` (`CLOUDFLARE_ACCOUNT_ID`
   est déjà renseigné pour Workers AI). Sur le serveur, en root, installe l'outil une fois :
   `npm install -g wrangler`. Les Workers du bot ne peuvent pas appeler d'IA ni Telegram et n'ont aucune
   clé : ce sont des pages de service, pas des copies du bot.

Sans compte : `france_data address` (adresses et communes, API Adresse de l'État) marche d'office.
Dans `/sante`, la ligne « Services gratuits (tes comptes) » montre ce qui est actif et combien d'appels
ont été faits aujourd'hui.

## Tes interventions

Pour gagner de l'argent, le bot te demandera (via `request_help`) : un nom de domaine (domaine
personnalisé GitHub Pages), l'inscription à un programme d'affiliation, une régie publicitaire ou un
lien de paiement Stripe. Pour que les ventes Stripe soient comptées automatiquement, refais l'étape 3
puis relance la configuration (étape 7) sans `--no-stripe`.

Outils gratuits ou économiques à sa disposition :
- `harvest` : lecture et extraction par les IA gratuites ci-dessus (repli sur Haiku si aucune ne répond) ;
- `market_signals` : mesure gratuite de la demande (Hacker News, Reddit, suggestions Google, audience
  Wikipedia, GitHub, Stack Exchange), avec des liens datés qu'il cite comme preuves ;
- `dataset` : ses données de recherche gardées d'un jour à l'autre (`~/datasets`), pour ne pas payer deux
  fois la même recherche ;
- `monitor_site` : surveillance de ses sites toutes les 30 minutes ; si un site tombe, tu reçois
  « 🔴 Site hors ligne » sur Telegram et le bot est réveillé, puis « 🟢 » quand il revient ;
- `delegate` (lectures et rédactions confiées d'abord aux IA gratuites, puis à Claude Haiku si aucune ne
  répond ou pour un travail délicat), `schedule_job` (tâches automatiques sans frais),
  `recall` (recherche dans ses notes, ses idées et ses données), `audit_page` (notes Lighthouse) et
  `ab_test` (tests A/B sans cookies).

**Design.** Le bot a une méthode de design (compétence `money-lab-design`) et un kit de départ dans
`~/library/design` : une base CSS moderne, 6 styles très différents (sobre, chaleureux, éditorial,
ludique, technique, rétro), des gabarits de page, les composants et une liste de ressources gratuites
(polices, icônes, illustrations, palettes, sites d'inspiration). Avant de publier une page, il doit
passer `check_design` (accessibilité, mobile, images, polices, avec captures), `first_impression`
(test des 5 secondes par une IA gratuite) et `design_review` (Opus note la page sur captures d'écran
et donne les corrections ; quelques centimes). Le kit et les compétences se mettent à jour tout seuls
à chaque redémarrage.

**Code.** Le bot a aussi un atelier de code (compétence `money-lab-code`) : `repo_scout` cherche sur GitHub des dépôts réutilisables (licence vérifiée : MIT, Apache, BSD, ISC ; jamais de GPL ni de code sans licence), `vendor_code` en copie un dans `~/library/vendor` avec sa licence et sa provenance (il ne l'exécute jamais), `scaffold_site` crée un site complet à partir du kit en un appel (français ou anglais), `test_site` fait parcourir le site par un vrai navigateur (scénario, liens cassés, erreurs) et `code_review` fait relire son code par les IA gratuites. Un catalogue de bibliothèques éprouvées (PDF, images, tableurs, QR codes, graphiques…) est fourni dans la compétence.

**Trouver la bonne idée.** Le bot ne part plus d'une idée au hasard : `niche_scan` lui donne des catégories de besoins (métiers, démarches, moments de vie, obligations, données, tâches répétitives), il les développe en recherches concrètes avec les IA gratuites, puis mesure chaque niche avec des signaux comptés (suggestions Google, intention d'achat, audience, discussions, alternatives existantes) et une formule fixe ; les niches rejetées sont mémorisées avec la raison. Avant de construire un produit, il publie une **sonde** : une page utile faite en un jour, et Google Search Console dit après deux semaines si des gens la cherchent (`/sante` affiche les sondes en cours ; tu es prévenu sur Telegram quand une sonde réussit ou échoue). Les sondes exigent que Search Console soit configuré (point 5 ci-dessus).

**Publier pour lui.** Le bot ne peut pas poster sur les annuaires, forums ou groupes : il te prépare des **kits de publication** complets (où poster exactement, le titre, le texte à coller, le lien suivi, l'image, les règles du lieu). Ils arrivent sur Telegram ; tu colles, tu publies en ton nom, puis `/publie <id> <lien>` (ou `/passe <id> [raison]`). `/kits` liste ceux en attente, `/kit <id>` en réaffiche un. Au plus 3 par jour. Avant de construire un produit, tu vois aussi chaque **idée finaliste** pendant 24 h : `/choisis <id>` pour la lancer, `/ecarte <id> [raison]` pour la refuser ; sans réponse, Opus décide.

**Gratuit en plus (sans compte, ou presque).** Le bot lit les pages web via Jina Reader (texte propre, même sur les sites en JavaScript ; une clé gratuite sur https://jina.ai → *API Keys* dans `JINA_API_KEY` passe de 20 à 500 lectures par minute, facultatif). Sa mémoire (`recall`) cherche par sens grâce aux embeddings gratuits de Gemini, Mistral ou Cloudflare, déjà configurés avec tes clés. `design_review` passe d'abord par Gemini (gratuit) et ne va chez Opus qu'au moment de publier. Chaque sonde publiée est signalée à Bing et ses partenaires (IndexNow, gratuit, sans compte). `free_services` lui trouve un service ou une API gratuite pour un besoin donné. Pour des statistiques de visite en plus de GoatCounter : sur https://dash.cloudflare.com → *Analytics & Logs → Web Analytics → Add a site* (sans proxy), copie le `token` du snippet dans `CF_WEB_ANALYTICS_TOKEN` ; les nouveaux sites l'incluent.

**Les décisions importantes sont prises par Claude Opus 5.5**, et le programme les applique : approuver
une idée (elle devient une expérience) et arrêter une expérience active. Le bot prépare le dossier,
Opus tranche (environ 5 centimes par décision, compté dans le budget). Le rapport de santé indique les
décisions de la semaine. Le bilan hebdomadaire utilise aussi Opus pour ses 4 premiers tours, puis
revient à Sonnet ; tout reste soumis aux mêmes plafonds.

Le bot travaille seul. Il te sollicite seulement pour : créer des comptes à ton nom (hébergement,
Stripe, domaine, réseaux publicitaires), payer, confirmer les revenus hors Stripe et tout ce qui est
juridique (CGU, fiscalité). Il ne peut pas se répliquer, modifier son propre code ni lire tes clés.

## Arrêter le bot

1. Telegram : `/pause fin` (plus aucune dépense d'inférence).
2. Serveur : `systemctl stop money-lab` puis `systemctl disable money-lab`.
3. Sauvegarde (avant de supprimer quoi que ce soit) :
   `cp /home/moneylab/.automaton/state.db /root/sauvegarde-state.db`, puis télécharge-la chez toi.
4. **La pause n'arrête pas les factures** : supprime le VPS chez l'hébergeur, et tout service que tu as
   créé pour le bot, quand tu n'en as plus besoin.

## Limites à connaître

- Les plafonds sont appliqués dans le programme ; une commande shell détournée pourrait les contourner
  (le bot possède ses propres fichiers de configuration et de comptabilité). Les clés, elles, sont
  hors de portée de ses commandes avec le fichier de service actuel. Ta vraie protection reste la
  limite de dépense chez Anthropic et ce que tu mets sur le compte.
- Le bot meurt quand son solde passe sous zéro ; il revit si tu ajoutes des fonds ou si un revenu
  confirmé arrive.
