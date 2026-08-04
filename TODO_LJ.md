# TODO LJ — actions qui nécessitent l'humain

## 🔴 Sauvegarde du dépôt (priorité haute, 5 min)

Le dépôt n'a **aucun remote** aujourd'hui : tout Stellar tient sur un seul disque.
Créer un repo git **privé** sur GitHub et pousser — c'est le seul backup du projet.

```bash
gh repo create stellar --private --source=. --remote=origin --push
# ou : git remote add origin git@github.com:<toi>/stellar.git && git push -u origin main
```

Le `.gitignore` est en allowlist sur `config/` : rien n'y est versionné sauf
`regulation.yaml` et les `*.enc.yaml` / `*.enc.json` chiffrés. Pousser est sûr.

## 🔑 Sops/age — à initialiser (avant l'atelier Midea !)

Sans ça, les tokens Midea récoltés à l'étape suivante n'ont nulle part où aller
(spec §14 : aucun secret en clair, jamais commité déchiffré).

1. **Installer sops + age**
   ```bash
   winget install FiloSottile.age Mozilla.SOPS   # tour Windows
   brew install sops age                         # MacBook
   ```
2. **Générer la clé**
   ```bash
   age-keygen -o ~/.config/sops/age/keys.txt
   ```
3. **Sauvegarder la clé privée hors ligne** — gestionnaire de mots de passe **+**
   copie papier. **JAMAIS dans git.** Cette clé perdue = tous les secrets chiffrés
   du dépôt définitivement illisibles (tokens Midea inclus, et ils ne sont plus
   réémissibles — voir la section suivante).
   ⚠️ Les deux machines de dev (Mac + Windows) doivent avoir la clé : soit la même
   clé recopiée, soit deux clés publiques listées dans `.sops.yaml`.
4. **Coller la/les clé(s) publique(s)** (`age1...`, affichée par `age-keygen`) dans
   `.sops.yaml` à la racine, à la place du `# TODO_LJ:`.
5. **Chiffrer le certificat TV déjà présent** puis supprimer le clair :
   ```bash
   sops -e config/androidtv-cert.json > config/androidtv-cert.enc.json
   rm config/androidtv-cert.json
   ```

Raccourcis disponibles à la racine (package.json) :
`pnpm secrets:encrypt <fichier>` (chiffre **en place**, `sops -e -i`) et
`pnpm secrets:decrypt <fichier>` (déchiffre **sur stdout**, ne touche pas au fichier).

## ⚠️ P4.0 — Atelier tokens Midea (URGENT, la fenêtre cloud se referme)

Midea ferme progressivement ses API cloud de délivrance token/key (Meiju et SmartHome
déjà fermées côté nouvelles apps, NetHome Plus en sursis). Les appareils déjà
provisionnés continuent en local à vie — c'est **l'obtention** des tokens qui a une
date de péremption inconnue. À faire dès qu'un créneau se libère, depuis le LAN de la
maison (spec §9 midea-driver) :

1. Réserver des IP fixes (baux DHCP statiques) pour les 3 dongles des clims
   (salon, entree, chambre).
2. Depuis le Mac ou la tour (PAS depuis Docker/VM — le discovery est un broadcast UDP) :
   ```bash
   npx node-mideahvac
   midea-discover --user=<email-compte-SmartHome> --password=<mdp>
   ```
   → noter **id / token / key / IP** pour chacune des 3 unités.
3. Plan B si l'étape 2 échoue : `pipx install msmart-ng` (CLI équivalent, comptes
   intégrés disponibles).
4. Me donner les résultats en session → j'archive le tout chiffré (sops/age) dans
   `config/` — c'est l'assurance-vie du parc de clims.

## P2 — Lumières & prises (pour valider le DoD matériel)

- Récupérer l'IP du bridge Hue (app Hue → paramètres → bridge) et lui réserver un
  bail DHCP statique.
- `HUE_BRIDGE_URL=https://<ip> stellar-hue pair` puis appuyer sur le bouton du
  bridge (fenêtre de 60 s) — la clé est persistée, à chiffrer sops ensuite.
- `stellar-hue verify` : inventaire lecture seule → fixtures réelles enregistrées,
  et réponse à l'ADR-006 (la TV est-elle branchée sur une prise connectée ?).
- Puis `stellar-hue run` et le DoD : `stellar cmd hue <entité> set '{"on":true}'`.

## P3 — Netatmo (pour brancher le vrai thermostat + la station)

1. Créer une app OAuth sur https://dev.netatmo.com (Mon compte → My apps → Create) :
   noter **client id** et **client secret**.
2. Sur la page de l'app, utiliser le **Token generator** : cocher les scopes
   `read_thermostat write_thermostat read_station`, générer, et noter le
   **refresh token**.
3. Créer le fichier de tokens (gitignoré, à chiffrer sops ensuite) :
   ```bash
   echo '{"refreshToken":"<le-refresh-token>"}' > config/netatmo-token.json
   ```
4. `NETATMO_CLIENT_ID=… NETATMO_CLIENT_SECRET=… stellar-netatmo verify` →
   fixtures réelles enregistrées, puis `run`. DoD réel : changer la consigne
   depuis le bus (`stellar cmd netatmo thermostat_maison set '{"targetTemp":21}'`)
   et la voir dans l'app Netatmo.

⚠️ Le driver rafraîchit et fait tourner le refresh token tout seul ensuite —
ne jamais régénérer un token depuis le portail pendant que le driver tourne
(ça invaliderait le sien).

## P5 — Serveur + percepts (matériel ~380 €, quand tu veux)

1. Achats (spec §3) : mini PC N100 16 Go/500 Go (~180 €), dongle Sonoff
   ZBDongle-E (~28 €), 5× SNZB-02D (~65 €), 2× mmWave selon ADR-002 (~50 €),
   LiXee ZLinky (~55 €). Me donner la **puissance souscrite** (kVA) pour le
   délestage P6.
2. N100 : Linux + docker, Ethernet si possible, bail DHCP statique. Migrer
   l'infra (`docker compose up -d` + `STELLAR_MQTT_BIND=0.0.0.0` — voir le
   commentaire du compose) et installer les units systemd de `infra/systemd/`.
3. Zigbee2MQTT en container (dongle sur rallonge USB, canal 25/26), appairer les
   capteurs avec des friendly_name parlants (`temp_salon`, `presence_salon`,
   `zlinky`…) et compléter `config/z2m-mapping.json` (une ligne par capteur).
4. `stellar-z2m dump` 30 s → fixtures réelles pour recaler le simulateur.
5. Démo stale réelle : retirer la pile d'un capteur, attendre le seuil, vérifier
   l'alerte (`home/event/core/stale_alert`).

## P6 — Tempo + régulation

- **Me donner la puissance souscrite Linky (kVA)** — le `max_va` de
  `config/regulation.yaml` est une hypothèse à 9 kVA en attendant.
- Optionnel (le fallback opendata marche sans compte) : compte
  https://data.rte-france.com → créer une application → souscrire l'API « Tempo
  Like Supply Contract » → me donner client id/secret (sops) pour la source
  primaire RTE.
- Relire `config/regulation.yaml` (consignes par pièce, plage nuit, ordre de
  délestage) — ce sont TES réglages de confort, j'ai mis des valeurs plausibles.

## P7 — Agent (pour les runs réels)

- Clé API Anthropic dans l'env du service agent (`ANTHROPIC_API_KEY`, sops) —
  budget loggé par jour, sessions éphémères.
- Choisir la source de l'agenda du planner du matin (Google Calendar ? autre ?)
  — question ouverte de la spec §17.
- Choisir le fournisseur de cours de bourse pour `market_quote` (le tool est
  prêt avec un provider pluggable + fake).

## P8 — Voix (matériel ~200-270 €, après P5)

1. Acheter 3-4× Home Assistant Voice PE (~65 €/u).
2. Sur le N100 : `docker compose -f infra/docker-compose.voice.yml up -d`
   (HA allégé + whisper fr + piper fr), copier
   `infra/ha/custom_components/stellar_conversation/` dans le config HA,
   activer le pont : `CORE_HA_BRIDGE=1` sur le service core → toutes les
   entités du bus apparaissent dans HA (intents locaux + app mobile).
3. Appairer les Voice PE (wake word intégré « Okay Nabu » pour le bring-up).
4. DoD réel : minuteur < 1 s ; conversation multi-tours depuis le salon ;
   annonce du planner au réveil.
5. Plus tard (hors DoD) : entraîner « OK Stellar » (openWakeWord) et trancher
   ADR-007.

## P9 — Prédictif (quand le journal aura ~4 semaines de données réelles)

- Relire le profil d'occupation (`formatProfile` — exposé sur le handle de
  régulation) et, s'il te semble juste, activer `preconditioning.enabled: true`
  dans `config/regulation.yaml`.

## P1 — La télé (pour valider le DoD)

- Activer la **veille réseau** sur la TV Android TV (ne jamais la couper par une prise).
- Réserver une IP fixe pour la TV (bail DHCP statique) et me la donner.
- Lancer le pairing (code affiché à l'écran de la TV) quand le driver sera prêt —
  procédure guidée fournie par le driver.

## Infos manquantes (spec §17, à me donner quand tu les as)

1. Puissance souscrite Linky (kVA) — nécessaire au délestage (P6).
2. Liste complète des pièces + emplacement prévu des capteurs et satellites.
3. Inventaire du bridge Hue — la TV est-elle branchée sur une prise connectée ? (ADR-006)
4. Source d'agenda pour le planner du matin (Google Calendar ? autre ?).
5. ADR ouverts à trancher : 002 (modèle mmWave), 003 (HA long terme vs UI custom),
   007 (moteur wake word).

## Premier démarrage réel de l'infra (validation P0 en conditions réelles)

```bash
docker compose -f infra/docker-compose.yml up -d
node apps/cli/dist/main.js states --follow
```
