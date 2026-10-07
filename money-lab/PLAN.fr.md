# Plan d'amélioration de Money Lab

Chaque étape : je construis et teste sur la simulation, tu mets à jour le serveur, on observe quelques
jours. Les règles de sécurité restent : pas de copie de lui-même, pas de création de comptes, pas de
CAPTCHA, pas tes comptes personnels, pas de dépassement des plafonds.

| Étape | Contenu | Ce que tu fais | État |
|---|---|---|---|
| 1 | `delegate` (Haiku, 2× moins cher), `schedule_job` (tâches gratuites), `recall` (mémoire) | Mise à jour | Fait (2026-10-06) |
| 1 bis | Réfléchir avant de construire : entonnoir d'idées notées, critique par Opus, 6 h de réflexion, lancement bloqué sans idée validée | Mise à jour | Fait (2026-10-06) |
| 1 ter | Corrections après observation : date du jour dans ses consignes, sommeil limité à 3 h tant qu'il a moins de 5 idées notées, recherche comptée comme du progrès | Mise à jour | Fait (2026-10-06) |
| 2 | `audit_page` (Lighthouse), `ab_test` (tests A/B sans cookies) | Mise à jour | Fait (2026-10-06) |
| 3 bis | IA gratuites pour la récolte (`harvest`), décisions confiées à Opus (approbation des idées, arrêt des expériences), signaux de marché gratuits (`market_signals`), données gardées (`dataset`), surveillance des sites (`monitor_site`), rapport de santé | Créer 1 à 3 clés d'IA gratuites ; Ollama si le serveur a assez de mémoire | Code fait (2026-10-06), clés à créer |
| 3 ter | Design : kit de départ (base CSS, 6 styles, gabarits), méthode (compétence `money-lab-design`, ressources gratuites), `check_design` (contrôles gratuits + captures), `first_impression` (test 5 secondes), `design_review` (Opus juge les captures) | Mise à jour | Code fait (2026-10-07) |
| 3 | Nom de domaine choisi par le bot (`check_domain`, il te demande l'achat), images pour les réseaux (`render_image`), publication Bluesky validée par toi (`post_social`, `/publier`) | Acheter le domaine, créer le compte Bluesky | Code fait (2026-10-06), comptes à créer |
| 4 | Adresse e-mail dédiée (après le domaine) | Créer l'adresse | À faire |
| 5 | Revenus : Stripe, affiliation, publicité | Statut, comptes | Après le reste |

## Étape 3 ter : des sites jolis, simples et originaux

- **Kit de départ** (`~/library/design`) : `base.css` (tailles de texte fluides, espacements réguliers,
  boutons et formulaires accessibles, mode sombre, impression), 6 thèmes (polices Google Fonts +
  palette), gabarits `tool.html` et `landing.html`, page de composants, guide des icônes.
- **Méthode** (compétence relue à chaque site) : brief de design avant le code (lecteur, action unique,
  deux adjectifs, 3 concurrents, un élément distinctif), règles du beau simple (espace, 2 polices, une
  couleur d'accent, mobile d'abord, vrai contenu), signaux de confiance honnêtes, ressources gratuites
  à consulter (polices, palettes, composants, inspiration, illustrations, icônes, images, accessibilité).
- **Contrôles** : `check_design` (axe-core, débordement mobile, cibles tactiles, images, polices, titre,
  description, viewport, favicon, og:image, erreurs console, poids, captures ordinateur + mobile),
  `first_impression` (une IA gratuite lit ce qu'un visiteur voit en 5 secondes), `design_review` (Opus
  voit les deux captures et le texte, note 9 critères, donne les corrections précises, verdict SHIP ou
  FIX FIRST), puis `audit_page` et `view_page` avant publication.

## Étape 3 bis : les IA gratuites récoltent, la meilleure décide

- **Récolte gratuite.** `harvest` lit jusqu'à 8 pages, ses fichiers ou du texte et en extrait ce qu'il
  demande, avec des IA gratuites : Gemini, Groq, les modèles gratuits d'OpenRouter, ou un modèle installé
  sur le serveur (Ollama). Les textes longs sont découpés. Si aucune ne répond, repli sur Haiku (payant).
  Les clés restent dans le programme ; toute clé présente dans les textes est masquée avant l'envoi.
- **Décisions par Opus.** Approuver une idée et arrêter une expérience active passent obligatoirement par
  Opus, qui reçoit un dossier complet (notes, critiques, preuves, autres idées, argent restant). Sa
  décision est appliquée par le programme : APPROVE, REJECT ou NOT YET pour une idée, STOP ou CONTINUE
  pour une expérience.
- **Preuves chiffrées.** `market_signals` compte la demande sans compte ni frais : Hacker News, Reddit,
  suggestions Google, audience Wikipedia, GitHub, Stack Exchange, avec des liens datés.
- **Mémoire des données.** `dataset` garde ce qu'il récolte dans `~/datasets`, et `recall` le retrouve :
  il ne paie pas deux fois la même recherche.
- **Surveillance.** `monitor_site` vérifie ses sites toutes les 30 minutes ; une panne te prévient et le
  réveille.

## Étape 3 : domaine, images, réseaux

- **Domaine.** `check_domain` interroge les registres (RDAP, gratuit) : libre ou pris, avec la date
  d'expiration. Le bot choisit lui-même entre un domaine unique (outils dans des dossiers,
  `marque.fr/devis/`, conseillé pour Google) et des sous-domaines. Il te demande l'achat avec son choix,
  deux alternatives, le prix et ses raisons. Il prépare ensuite GitHub Pages et te donne les
  enregistrements DNS à saisir chez OVH.
- **Images.** `render_image` : il dessine en HTML/CSS et Chrome produit un PNG aux formats des réseaux
  (aperçu de lien 1200×630, carré 1080×1080, portrait, story, bannière). Gratuit.
- **Bluesky.** `post_social` : il rédige, tu reçois chaque brouillon sur Telegram et tu réponds
  `/publier <id>` ou `/rejeter <id> [raison]`. Au plus 3 publications par jour, ni réponses ni messages
  privés. `/publications auto` supprime la validation, `/publications validation` la remet. Le mot de
  passe d'application est lu par le programme, jamais par le bot.

## Étape 1 bis : réfléchir avant de construire

Problème constaté : le bot a construit un générateur de factures, un outil très courant, sans étude
sérieuse. Désormais :

1. **Phase de découverte.** Il explore beaucoup de niches (métiers, loisirs, besoins locaux, données
   difficiles à obtenir, tâches répétitives), lit ce que les gens demandent et ce dont ils se plaignent,
   étudie la concurrence. Prendre 2 ou 3 jours pour ça est encouragé.
2. **Chaque idée est notée sur 9 critères**, de 0 à 10, chaque note justifiée par des faits :
   - demande prouvée (poids 2) ;
   - place laissée par la concurrence (1,5) ;
   - originalité (1) ;
   - facilité de marketing sans pub ni spam (1,5) ;
   - facilité de construction (1) ;
   - coût de fonctionnement (0,5) ;
   - potentiel de revenus (1,5) ;
   - avantage de son propre serveur (1) : données collectées, traitements, API, automatisation qu'un
     simple site copié ne peut pas offrir ;
   - rapidité pour savoir si ça marche (1).
   Le total est ramené sur 100.
3. **Critique.** Claude Opus joue l'investisseur sceptique : verdict GO, NO-GO ou « preuves
   insuffisantes », points faibles, preuves manquantes, meilleur angle. Le bot doit répondre à la
   critique. Environ 5 centimes par critique, 3 critiques maximum par idée.
4. **Validation**, appliquée par le programme. Il faut :
   - les 9 critères notés et au moins 3 sources ;
   - au moins 2 concurrents étudiés ;
   - au moins 5 idées comparées, et celle-ci dans le top 3 ;
   - un total d'au moins 60 ;
   - une critique qui n'est pas NO-GO, et la réponse du bot à cette critique ;
   - des critères d'arrêt chiffrés ;
   - **6 h de réflexion** depuis la première notation.
5. **Lancement.** Une expérience ne peut passer en construction qu'avec une idée validée, et au plus 3
   expériences actives à la fois. Les expériences existantes (dont le générateur de factures) continuent,
   mais seront notées comme des idées au prochain bilan hebdomadaire, qui peut décider de les arrêter.
