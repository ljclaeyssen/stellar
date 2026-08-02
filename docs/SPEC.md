# SPEC — « Stellar » v3 — document autonome

> Ce document est **autosuffisant** : il contient tout le contexte nécessaire pour travailler sur le projet sans aucune conversation antérieure. Le lire en intégralité avant toute session. En cas de doute : ce document fait foi, puis les ADR, puis demander à l'humain.

## 1. Contexte & vision

L'utilisateur (dev Angular/TypeScript expérimenté, full stack TS, travaille seul, machines de dev : MacBook Pro + tour Windows, maison en région lilloise) remplace son Amazon Echo par un système domotique vocal **homemade** :

- **Exécution 100 % locale** : la maison fonctionne sans internet.
- **Intelligence via agent LLM** (Claude, API Anthropic) : conversation vocale libre, planification énergétique, création d'automatisations — mais jamais de contrôle temps réel.
- **Philosophie** : minimum de produits/plateformes externes, maximum de code maison en TypeScript. Pas de logique dans des composants tiers (Home Assistant réduit à la plomberie vocale).
- **Inspiration** : la plateforme Constellation de Sébastien Warin (2015-2018) — un bus d'interconnexion avec « StateObjects » (états partagés) et « MessageCallbacks » (méthodes découvrables). On en reconstruit le cœur avec des primitives modernes : StateObjects → messages MQTT retained ; MessageCallbacks → request/response MQTT 5 ; découverte → manifestes JSON Schema retained. **Sans** la plateforme autour (pas de console, pas de package manager, pas de SDK multi-langages : c'est ce qui a tué Constellation, porté par un homme seul).

Budget total ≈ 600–650 € étalé, **0 € avant la phase P5**. Coût récurrent : API Claude (quelques €/mois, budget loggé).

## 2. Glossaire

- **MQTT retained** : le broker conserve le dernier message d'un topic et le sert à tout nouvel abonné → magasin d'états gratuit.
- **LWT (Last Will and Testament)** : message publié par le broker quand un client disparaît → détection online/offline des drivers.
- **MQTT 5 request/response** : propriétés response-topic + correlation-data → RPC propre sur MQTT.
- **Zigbee2MQTT (Z2M)** : passerelle open source Zigbee ↔ MQTT, tourne standalone (sans Home Assistant).
- **mmWave** : capteur de présence radar — détecte une personne immobile (contrairement au PIR).
- **Linky / TIC / ZLinky** : compteur électrique français / sa sortie télé-information / module LiXee qui la publie en Zigbee (puissance instantanée, index).
- **EDF Tempo** : contrat d'électricité français. Chaque jour a une couleur — **bleu** (~300 j/an, pas cher), **blanc** (43 j), **rouge** (22 j, concentrés novembre-mars). Prix du kWh en **HP** (heures pleines, 6 h–22 h) d'un jour rouge ≈ 4–5× le tarif normal ; les **HC** (22 h–6 h) restent abordables toutes couleurs. La couleur du lendemain est publiée la veille (vers 11 h) par RTE.
- **PAC** : pompe à chaleur — ici les clims réversibles Midea, utilisées en chauffage hors jours rouges.
- **SmartKey / sk103 / OSK103** : dongle WiFi d'origine des clims Midea. Parle un protocole LAN chiffré (discovery UDP 6445, contrôle TCP 6444) nécessitant un couple token/key obtenu via le cloud Midea (une seule fois, réutilisable à vie).
- **CLIP v2** : API REST locale du bridge Philips Hue (HTTPS + header `hue-application-key`, event stream SSE).
- **Wyoming** : protocole des services vocaux de l'écosystème Home Assistant (faster-whisper pour le STT, piper pour le TTS).
- **Voice PE** : Home Assistant Voice Preview Edition — satellite vocal officiel (ESP32-S3 + DSP XMOS, wake word embarqué microWakeWord, ~65 €).
- **Assist / intents** : le moteur de commandes vocales déterministe de Home Assistant (rapide, local, vocabulaire fermé).
- **MCP (Model Context Protocol)** : protocole standard exposant des tools découvrables à un LLM.
- **Claude Agent SDK** : lib TypeScript/Python embarquant le moteur agentique de Claude Code (boucle d'outils, permissions, MCP client) dans un process applicatif.
- **sops/age** : chiffrement de fichiers de secrets versionnables dans git.
- **HACS** : store de composants communautaires Home Assistant — **interdit ici** pour la logique.
- **DoD** : Definition of Done. **ADR** : Architecture Decision Record.

## 3. Inventaire physique

### Existant (0 €)
| Équipement | Détails |
|---|---|
| Philips Hue Bridge | Lampes + prise(s) connectée(s) sur le bridge. Inventaire exact en P2 (ADR-006 : prises). |
| TV Android TV | Contrôle local via protocole Remote v2 (pairing par code affiché à l'écran). **Veille réseau à activer ; ne jamais couper son alimentation par une prise.** IP fixe à réserver. |
| Thermostat Netatmo | Pilote la chaudière gaz (chauffage central). |
| Station météo Netatmo | T° int/ext, humidité, CO2. |
| 3 clims Midea | Pièces : **salon**, **entree**, **chambre**. Dongles WiFi d'origine (SmartKey). Compte actif sur l'app Midea « SmartHome ». Chaque unité remonte sa T° intérieure. |
| Compteur Linky | Puissance souscrite : **à demander à l'humain** (nécessaire au délestage). |
| Machines de dev | MacBook Pro / tour Windows — hébergent l'infra en P0–P3. |

### À acheter en P5 (~380 €)
Mini PC N100 16 Go/500 Go (~180 €) · dongle Zigbee Sonoff ZBDongle-E (~28 €) · 5× capteurs T°/humidité Zigbee SNZB-02D (~65 €) · 2× mmWave (ADR-002, ~50 €) · LiXee ZLinky (~55 €).

### À acheter en P8 (~200–270 €)
3–4× Home Assistant Voice PE (~65 €/u).

### Réseau
LAN unique — **WiFi mesh en place : compatible**, sous conditions : un seul SSID/sous-réseau (jamais le réseau invité pour l'IoT), isolation AP/client désactivée ; le discovery broadcast Midea peut être filtré par le mesh → cibler les IP fixes ; coexistence 2,4 GHz : canaux WiFi fixés (1/6/11), canal Zigbee éloigné (25/26), dongle Zigbee sur rallonge USB loin du N100 ; N100 raccordé en Ethernet si possible. Réserver des baux DHCP statiques pour : bridge Hue, la TV, les 3 dongles Midea, (plus tard) le N100. Zéro port ouvert vers l'extérieur ; accès distant via Tailscale uniquement.

### Pièces (liste initiale, à confirmer avec l'humain)
`salon`, `entree`, `chambre` (équipées clim) + autres pièces à inventorier (cuisine, sdb, bureau…).

## 4. Principes non négociables (avec leur pourquoi)

1. **Le LLM n'est jamais dans une boucle de régulation temps réel** ni en contrôle de safety-critical (`lock`, alarmes, incendie). *Pourquoi : latence, coût, non-déterminisme ; un thermostat doit marcher à 3 h du matin sans API.*
2. **Internet coupé → la maison continue.** Toute la régulation est locale et déterministe. *L'IA se tait, la maison vit.*
3. **Tout état transite par MQTT (retained). Toute décision vit dans `apps/core`.** Les drivers traduisent, ils ne décident pas.
4. **Contrats zod partagés**, validation à chaque frontière de process. Message invalide → loggé et jeté.
5. **Pas de logique dans des composants tiers** (HACS interdit ; HA = plomberie voix + UI de secours uniquement).
6. **Crash-isolation** : un process par driver, restart auto.
7. **Ouverture** : core et agent ne référencent **jamais** un driver par son nom — uniquement des sélecteurs `kind` + `room`. Nouvel objet = un driver ou une ligne de mapping, zéro impact ailleurs.
8. **Achat futur : Zigbee d'abord** (arrive par Z2M déjà en place, extensibilité gratuite).
9. **Agent = Claude Agent SDK embarqué en service Node, sessions éphémères.** Claude Code CLI sert à *construire* Stellar (sessions de dev), jamais à le faire tourner.

## 5. Architecture d'ensemble

```
Satellites Voice PE ──audio──▶ HA allégé (Assist: Whisper/Piper, routage)
                                   │ fast: intents locaux (entités via pont HA-discovery)
                                   │ slow: conversation agent
                                   ▼
                              apps/agent (Claude Agent SDK) ──▶ API Anthropic, Web
                                   │ tools MCP
                                   ▼
                              apps/core (miroir, journal, régulation, MCP, pont HA)
                                   ▲│
                            states ││ cmd
                                   │▼
                   ┌────────── BUS MQTT Mosquitto ──────────┐
                   ▼            ▼           ▼          ▼          ▼
              hue-driver  netatmo-drv  midea-drv  tempo-drv  z2m-normalizer(+Z2M)
                   │            │           │          │          │
               Hue Bridge   Cloud Netatmo  LAN sk103  API RTE   Zigbee (capteurs, ZLinky)
              (LAN)         (thermostat)   (3 clims)
```

Cloud strictement nécessaire : API Anthropic (cerveau), Web search/fetch (info fraîche), cloud Netatmo (leur API), API RTE (Tempo). Tout le reste est LAN.

## 6. Bus MQTT — conventions et exemples

Topics :
- `home/state/<driver>/<entityId>` — **retained**, contrat `Entity`
- `home/cmd/<driver>/<entityId>` — commande ; réponse via MQTT 5 response-topic + correlation-data (fallback `home/ack/<commandId>`)
- `home/event/<driver>/<type>` — ponctuel, non retained (ex. futur `home/event/doorbell/pressed`)
- `home/discovery/<driver>` — **retained**, manifeste de capacités
- `home/health/<driver>` — LWT `{"status":"online"|"offline","ts":…}`

QoS 1 partout. JSON. Timestamps ISO 8601 UTC. `entityId` en snake_case : `<type>_<room>[_<detail>]` → `clim_salon`, `temp_chambre`, `light_salon_canape`, `plug_tv`, `thermostat_maison`, `power_maison`, `tempo_jour`.

Exemples de payloads :
```json
// home/state/midea/clim_salon (retained)
{ "id":"clim_salon","driver":"midea","kind":"climate","room":"salon",
  "value":{"power":true,"mode":"heat","targetTemp":20.5,"indoorTemp":19.8,"fan":"auto"},
  "ts":"2026-11-14T06:12:03Z" }

// home/cmd/midea/clim_salon
{ "id":"c1f0…","target":"clim_salon","action":"set",
  "params":{"power":true,"mode":"heat","targetTemp":21},
  "issuedBy":"core","ts":"2026-11-14T06:12:04Z" }

// réponse (response-topic) / home/ack/c1f0…
{ "commandId":"c1f0…","status":"ok" }
```

## 7. Contrats (`packages/contracts`)

```ts
export const Kind = z.enum(['temperature','humidity','presence','power','climate',
  'light','plug','media','tempo','weather',
  'cover','button','doorbell','lock']); // les 4 derniers : réservés futur ; 'lock' jamais piloté par l'agent

export const Entity = z.object({
  id: z.string(), driver: z.string(), kind: Kind,
  room: z.string().optional(),
  value: z.unknown(),            // affiné par kind via des schémas dédiés (ClimateValue, TempoValue…)
  unit: z.string().optional(),
  ts: z.string().datetime(),
  stale: z.boolean().optional(),
});

export const Command = z.object({
  id: z.string().uuid(), target: z.string(), action: z.string(),
  params: z.record(z.unknown()),
  issuedBy: z.enum(['core','agent','voice','ui','cli']),
  ts: z.string().datetime(),
});

export const Ack = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['ok','rejected','timeout']),
  reason: z.string().optional(),
});

export const Manifest = z.object({
  driver: z.string(), version: z.string(),
  entities: z.array(EntityDecl),
  commands: z.array(z.object({ action: z.string(), paramsSchema: z.record(z.unknown()) })), // JSON Schema
});
```

Schémas de `value` par kind à définir en P0 (au minimum : temperature=number °C ; climate={power,mode:'heat'|'cool'|'fan'|'dry'|'auto',targetTemp,indoorTemp?,fan} ; light={on,brightness?,color?} ; plug={on} ; power={va,indexBase…} ; tempo={couleurJour,couleurDemain,periode:'HP'|'HC'} ; presence=boolean).

**Règle d'évolution** : ajouter une famille d'objets = une seule PR partagée (le `kind` + son schéma de value). Tout le reste est local au driver. Export JSON Schema (via zod-to-json-schema) pour les manifestes discovery et le MCP.

## 8. `packages/bus` — API attendue

```ts
const bus = await createBus({ url, clientId, driver });   // gère LWT + reconnexion backoff expo
bus.publishState(entity);                                  // retained, QoS1
bus.onState(selector, cb);                                 // selector = {kind?, room?, driver?, id?}
bus.sendCommand(cmd, {timeoutMs=5000}): Promise<Ack>;      // req/resp MQTT5, timeout → Ack 'timeout'
bus.onCommand(handler): void;                              // handler(cmd) => Promise<Ack>
bus.publishEvent(evt); bus.onEvent(pattern, cb);
bus.announce(manifest);                                    // discovery retained + health online
```

## 9. Drivers

Règles communes : un process par driver ; reconnexion backoff exponentiel ; manifeste retained au démarrage ; health LWT ; **zéro logique métier** ; logs JSON structurés (`{ts,level,driver,msg,…}`) sur stdout ; erreurs protocolaires → retry, jamais de crash-loop silencieux.

### hue-driver (P2)
- Bridge en LAN, API **CLIP v2** : `https://<ip-bridge>/clip/v2/resource/...`, header `hue-application-key`.
- Obtenir l'application key : POST `/api` avec `{"devicetype":"orion#core"}` dans les 30 s après appui sur le bouton physique du bridge (procédure une fois, key en sops).
- États temps réel via l'event stream SSE `/eventstream/clip/v2` (pas de polling).
- Expose : lights (`light`), smart plugs (`plug`).

### androidtv-driver (P1)
- TV Android TV en LAN, **protocole Android TV Remote v2** (TLS ; remote port 6466, pairing port 6467). Pairing une fois par code affiché à l'écran ; certificat persisté en sops.
- Lib : `@kud/androidtv-remote` (implémentation TypeScript ; alternative historique : `androidtv-remote` de louis49, utilisée par Home Assistant).
- Commandes : `power`, `launch_app` (deep link ou nom de package — ex. Netflix), `key` (RemoteKeyCode), `volume`, `send_text`.
- Percept `media` (`tv_salon`) : `{power, currentApp, volume}` alimenté par les events du protocole (powered / current_app / volume).
- Prérequis : veille réseau activée sur la TV, IP fixe. La TV n'est jamais alimentée via une prise pilotée.

### netatmo-driver (P3)
- Créer une app OAuth2 sur dev.netatmo.com ; scopes thermostat (lecture/écriture) + station. Refresh token **impérativement** rafraîchi et persisté (sops) — un refresh raté = réauthentification manuelle.
- Respecter les rate limits documentés (polling raisonnable : 5 min météo, 1–2 min thermostat).
- Thermostat : lecture T° ambiante/consigne/mode, écriture consigne et mode (`climate`, actionneur `thermostat_maison` → chaudière). Station : percepts `temperature`/`humidity`/`weather`.

### midea-driver (P4) — lire attentivement, contexte critique
- **Matériel** : dongles d'origine conservés (décision ADR-005). Transport LAN « sk103 » via `packages/midea-protocol` = **wrapper typé de la lib npm `node-mideahvac`** (mode `sk103`). On ne réimplémente le protocole que si la lib bloque réellement.
- **Tokens (P4.0, atelier prioritaire, faisable dès aujourd'hui — la fenêtre se referme)** : Midea ferme progressivement ses API cloud de délivrance de token/key (Meiju et SmartHome déjà fermées, NetHome Plus en sursis). Les appareils déjà configurés continuent en local à vie ; c'est **l'obtention** qui a une date de péremption inconnue. Procédure :
  1. Réserver des IP fixes pour les 3 dongles.
  2. `npx node-mideahvac` → `midea-discover --user=<email> --password=<mdp>` avec le compte **SmartHome** (seul type de compte supporté) → noter id/token/key/IP par unité. Discovery = broadcast UDP même sous-réseau ; **ne pas** lancer depuis Docker/VM ; sinon cibler l'IP directement.
  3. Plan B : `pipx install msmart-ng` (lib Python maintenue, CLI équivalent, comptes intégrés disponibles).
  4. Archiver le tout **chiffré (sops)** dans `config/` — c'est l'assurance-vie du parc.
- **Contraintes runtime** : le SK103 décroche du WiFi si pollé agressivement (power-cycle nécessaire). Donc : polling doux 30–60 s, keepalive léger, resynchronisation d'état au reconnect, alerte health si injoignable > 5 min. Un thermostat n'a pas besoin de temps réel.
- Publie par unité : `climate` (clim_salon/entree/chambre) **et** la T° intérieure en percept `temperature` (approximatif — sonde en haut du mur ; sert de fallback avant/en complément des capteurs Zigbee).
- **Plan B matériel documenté** (si fiabilité insuffisante) : remplacer le dongle par un pont série ESP32 (le dongle n'est qu'un pont vers l'UART interne de la clim) — même interface driver, seul le transport change.

### tempo-driver (P6)
- Source : API RTE (portail data.rte-france.com → créer un compte + une application → OAuth2 client credentials → API « Tempo Like Supply Contract »). Fallback : API opendata publique sans compte.
- Publie `tempo_jour` (kind `tempo`) : `{couleurJour:'bleu'|'blanc'|'rouge', couleurDemain:…|'inconnue', periode:'HP'|'HC'}`. La couleur du lendemain tombe la veille vers 11 h ; HP = 6 h–22 h.

### z2m-normalizer (P5)
- Zigbee2MQTT tourne en container, publie sur `zigbee2mqtt/<friendly_name>`.
- Le normalizer applique une **table de mapping déclarative** (friendly_name + modèle → entityId/kind/room/transformation de payload) vers nos contrats. Capteurs T°/humidité, mmWave (`presence`), ZLinky (`power` : puissance VA + index).
- **Tout objet Zigbee futur (volets `cover`, bouton/sonnette) = une ligne dans cette table.**

## 10. Core (`apps/core`)

- **Miroir** (P1) : souscrit `home/#`, état complet en mémoire, accès par sélecteurs.
- **Journal** (P5) : SQLite append-only (better-sqlite3) :
```sql
CREATE TABLE journal (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, topic TEXT NOT NULL,
  driver TEXT, entity_id TEXT, kind TEXT,
  payload TEXT NOT NULL, issued_by TEXT
);
CREATE INDEX idx_journal_entity_ts ON journal(entity_id, ts);
```
- **Stale** (P5) : seuils par kind (temperature 15 min, presence 5 min, power 2 min, climate 3× le polling) → republication avec `stale:true` + alerte.
- **API** (P5) : WebSocket + tRPC — `getState(selector)`, requêtes journal (par entité/période).
- **Serveur MCP** (P7) : tools `get_state(selector)`, `send_command(cmd)` (issuedBy forcé à `agent`), `subscribe(selector)`, `list_capabilities()` (agrégat des manifestes discovery), `query_journal(…)`. **Unique porte d'entrée de l'agent.**
- **Pont HA-discovery** (P8) : publie les configs MQTT discovery `homeassistant/<component>/<objectId>/config` (retained) mappées sur nos topics state/cmd → les entités du bus apparaissent dans Home Assistant (intents vocaux locaux + app mobile) **sans aucune logique côté HA**.
- **Régulation déterministe** (P6, `apps/core/src/regulation/`) :
  - Thermostat par pièce : hystérésis ±0,4 °C ; consigne selon mode `{present, absent, nuit, hors_gel:8}` ; choix d'actionneur (PAC de la pièce vs chaudière centrale) selon la politique énergie du jour.
  - **Politique Tempo** : demain rouge → préchauffe globale pendant les HC de la nuit (consignes +1 °C dès 2 h) ; jour rouge 6 h–22 h → PAC interdites, chaudière seule ; HC des jours rouges → PAC autorisées ; blanc → préférer le moins cher ; bleu → libre.
  - **Délestage** : puissance ZLinky > seuil (puissance souscrite − marge) → coupure des PAC dans l'ordre de priorité configuré, réarmement avec hystérésis.
  - **Fallbacks sûrs** : capteur stale → consigne conservatrice/hors-gel sur la pièce ; driver offline → alerte, aucune action risquée automatique ; jamais d'oscillation (anti-court-cycle : 5 min mini entre deux bascules d'un actionneur).
  - La régulation lit le miroir et émet des `Command` `issuedBy:'core'` — chaque décision est donc tracée dans le journal.
- Paramètres dans `config/regulation.yaml`, **versionné git — seul fichier modifiable par l'agent** (après validation humaine), jamais le code :
```yaml
rooms:
  salon:
    sensors: [temp_salon]            # fallback auto: clim_salon.indoorTemp
    actuators: { pac: clim_salon, central: thermostat_maison }
    setpoints: { present: 20.5, absent: 17, nuit: 18, hors_gel: 8 }
hysteresis: 0.4
energy:
  tempo_rouge: { hp: { pac: forbidden }, hc: { pac: allowed } }
  preheat_before_red: { start: "02:00", delta: 1.0 }
delestage: { max_va: 9000, shed_order: [clim_entree, clim_chambre, clim_salon] }
```

## 11. Agent (`apps/agent`)

- **Claude Agent SDK (TypeScript)** embarqué dans un service Node. Sessions **éphémères** spawnées à la demande (par tour de conversation / par tâche planifiée) — jamais de session immortelle (le contexte gonfle et dérive). Mémoire persistante = fichiers `memory/` (préférences, faits sur la maison) + journal via MCP.
- Tools (allowlist stricte) :
  - MCP du core (get_state, send_command, subscribe, list_capabilities, query_journal)
  - `WebSearch` / `WebFetch` (inclus dans le SDK) — actus, recettes, faits récents, avec sources
  - `market_quote` (custom : API de données de marché) — cours de bourse en direct
  - `propose_regulation_change` — produit un diff sur `config/regulation.yaml`, appliqué **uniquement après confirmation humaine** (vocale ou UI)
  - Planner du matin (cron 07 h) : lit Tempo demain/aujourd'hui + météo + agenda → publie les consignes du jour + annonce vocale résumée
  - Préconditionnement prédictif (P9) : probabilité d'occupation par pièce/créneau calculée depuis le journal → pré-chauffe/pré-clim douce
- **Garde-fous** : jamais `lock`/sécurité ; toute écriture persistante = confirmation ; budget tokens **et** recherches loggé par jour ; chaque action tracée `issuedBy:'agent'` dans le journal ; timeouts sur tout tool call.
- **System prompt vocal** (l'agent est un interlocuteur parlé) : réponses courtes (2–3 phrases, proposer d'approfondir) ; terminer par une question quand le dialogue doit continuer (cela rouvre le micro) ; tâche longue = accuser réception, exécuter en asynchrone, annoncer le résultat ensuite ; contenu volumineux (recette complète, tableau, liste) → notification téléphone via HA, jamais de lecture intégrale ; se présenter comme « Stellar Home » ; répondre en français.

## 12. Voix (P8)

- Satellites **Voice PE** (1/pièce, wake word embarqué).
- **Wake word : « OK Stellar »** — modèle custom à entraîner (openWakeWord : clips générés par Piper, quelques itérations de réglage ; 4 syllabes = bon candidat). Attention : l'entraînement openWakeWord est anglophone → prononciation à l'anglaise plus fiable, tester les faux positifs en réel. **Bring-up de la P8 sur un wake word intégré (« Okay Nabu »), bascule vers « OK Stellar » une fois le modèle validé — jamais bloquant pour le DoD.** Moteur (on-device vs serveur) : ADR-007.
- HA allégé héberge le pipeline Assist ; **Whisper** (faster-whisper) et **Piper** en containers Wyoming sur le N100.
- **Routage deux vitesses** : commandes réflexes → intents Assist locaux < 1 s (sur les entités du pont HA-discovery) ; tout le reste → `apps/agent` exposé comme conversation agent de HA (endpoint compatible).
- **Conversation** : multi-tours, contexte partagé (y compris les commandes traitées en local) ; réponse **streamée** (le TTS parle dès les premiers mots) ; réponse de l'agent finissant par une question → le micro se rouvre **sans wake word** (continue conversation). Tour par tour assumé : pas de micro ouvert en permanence.
- **Annonces sortantes** : le système initie le dialogue via `start_conversation` (planner du matin, alerte délestage, sonnette future), avec question/écoute si pertinent.

## 13. Extensibilité (« Constellation sans le zinzin »)

1. Nouveau device Zigbee → une entrée dans la table du z2m-normalizer, rien d'autre.
2. Nouveau device non-Zigbee → un driver autonome + éventuellement un `kind`. Core, agent, voix et UI le voient apparaître **sans modification ni redéploiement** (discovery retained → agrégée par le core → `list_capabilities`).
3. Événements ponctuels (sonnette) via `home/event/…`, déclencheurs d'annonces vocales.
4. Anti-zinzin : pas de chargement dynamique, pas de SDK plugin, pas de registre. Un « package » = un process Node ordinaire dans `apps/drivers/`.

Test d'acceptance (P9) : brancher à chaud un `fake-shutter-driver` → il apparaît dans les capacités et se pilote à la voix **sans qu'aucun commit n'ait touché core/agent**.

## 14. Résilience, sécurité, ops

- Tout en LAN, zéro port ouvert ; accès distant Tailscale uniquement.
- systemd/docker `restart=always` ; le core surveille `home/health/#` et alerte (notification HA).
- Secrets chiffrés **sops/age** (clé Hue, OAuth Netatmo, token/key Midea, clés API) — jamais en clair, jamais commit déchiffré.
- Backup quotidien off-site : dump SQLite + `config/` + manifestes.
- Logs JSON sur stdout partout ; agrégation simple (journald/docker logs suffisent au début).

## 15. Monorepo & conventions

Repo **privé unique**, pnpm workspaces :
```
/
├─ CLAUDE.md                  # règles de session (pointe ici) + « Phase en cours »
├─ docs/SPEC.md               # ce document — source de vérité
├─ docs/adr/                  # ADR-001…, un fichier par décision
├─ packages/contracts/        # zod + zod-to-json-schema, ZÉRO dépendance runtime autre
├─ packages/bus/              # client MQTT typé (mqtt.js)
├─ packages/midea-protocol/   # wrapper node-mideahvac + fixtures de trames
├─ apps/core/
├─ apps/agent/
├─ apps/cli/                  # inspection du bus, envoi de commandes, tail du journal
├─ apps/drivers/{hue,netatmo,midea,tempo,z2m-normalizer}/
├─ infra/                     # docker-compose.yml (mosquitto, z2m, ha, whisper, piper) + configs
└─ config/                    # regulation.yaml + secrets sops (*.enc.yaml)
```
Stack : TypeScript strict, Node 22, pnpm, vitest, zod, mqtt.js, tRPC, better-sqlite3, eslint+prettier. Pas de framework lourd. Tests : unitaires sur contracts/bus/midea-protocol/regulation (fixtures de trames et de scénarios) ; un fake-broker (aedes) pour les tests d'intégration bus.

## 16. Phases — une phase = un objectif de session, avec DoD

- **P0 — Socle** *(0 €, dev sur Mac/tour)* : scaffold monorepo ; contracts v1 (+ schémas de value par kind) ; packages/bus ; `infra/docker-compose.yml` avec mosquitto ; CI lint+test ; apps/cli squelette. *DoD : un fake-driver publie un state typé qu'un fake-consumer valide ; `pnpm test` vert ; `pnpm check:p0`.*
- **P1 — La télé** *(0 €)* : androidtv-driver (pairing TLS, cert en sops, power, launch_app, key, volume, events → percept `media`) ; core miroir minimal ; cli `states`/`cmd`. *DoD : « lance Netflix » fonctionne de bout en bout (TV réveillée + app ouverte) via `home/cmd` — le hello-world du projet.*
- **P2 — Lumières & prises** *(0 €)* : appairage CLIP v2 (application key) ; hue-driver complet (SSE → state, cmd → ack). Inventorier le bridge → trancher ADR-006 (prises). *DoD : tout ce qui est sur le bridge s'allume/s'éteint via `home/cmd`, ack < 300 ms.*
- **P3 — Chauffage Netatmo** *(0 €)* : app OAuth Netatmo ; netatmo-driver (thermostat + station). *DoD : consigne changée depuis le bus, visible dans l'app Netatmo ; météo en percepts.*
- **P4 — Clims Midea** *(0 €)* : **P4.0 atelier tokens — prioritaire et faisable dès aujourd'hui, avant même P0 (la fenêtre cloud se referme, voir §9 midea)** ; puis midea-protocol (wrapper + fixtures) + midea-driver. *DoD : état + consigne sur les 3 unités ; 3 T° intérieures publiées ; tokens archivés en sops.*
- **P5 — Serveur + percepts** *(~380 €)* : achat/installation N100, migration infra 24/7 ; Z2M + capteurs + ZLinky ; z2m-normalizer ; journal + stale + API tRPC dans le core. *DoD : états live via cli ; journal qui grossit ; alerte stale démontrée (pile retirée).*
- **P6 — Tempo + régulation** *(0 €)* : tempo-driver ; module régulation complet (thermostats, politique Tempo, préchauffe, délestage, fallbacks, anti-court-cycle) ; `config/regulation.yaml`. *DoD : une semaine d'autonomie sans intervention ; chaque décision relisible dans le journal avec sa cause.*
- **P7 — MCP + Agent v1** *(API)* : serveur MCP dans le core ; apps/agent (Agent SDK, tools web actifs, market_quote) d'abord en lecture/conseil, puis actions avec confirmation ; planner du matin. *DoD : « pourquoi la clim du salon a tourné cette nuit ? » → réponse exacte sourcée du journal.*
- **P8 — Voix** *(~200–270 €)* : HA allégé + Wyoming + Voice PE ; pont HA-discovery ; agent branché en conversation agent ; routage, streaming, continue-conversation, annonces ; entraînement du wake word « OK Stellar » (hors DoD). *DoD : minuteur local < 1 s ; conversation multi-tours suivie depuis le salon (micro rouvert sur question) ; annonce du planner au réveil.*
- **P9 — Prédictif + extensibilité** *(0 €)* : occupation probabiliste depuis le journal ; préconditionnement ; `propose_regulation_change` en flux diff+confirmation ; test fake-shutter (§13). *DoD : gain de confort mesurable sans hausse de conso les jours rouges ; test d'extensibilité vert.*

## 17. Méthode de travail (sessions Claude Code)

- Chaque session commence par : lire `CLAUDE.md` (phase en cours) puis ce document. **Une phase à la fois**, jamais d'anticipation sans demande explicite.
- Décision structurante → ADR court **avant** le code, format :
```
# ADR-00X — Titre
Date · Statut : proposé | accepté | remplacé
## Contexte  ## Décision  ## Conséquences  ## Alternatives écartées
```
- Trames/réponses matérielles réelles enregistrées en fixtures (`__fixtures__/`) avant d'implémenter un protocole.
- Commits conventionnels, petits. Chaque phase se valide par un script `pnpm check:pX` (créé avec la phase).
- Interdits absolus : logique métier dans un driver ; nom de driver dans core/agent ; dépendance HA/HACS pour la logique ; contrôle agent sur `lock`/sécurité ; secret en clair ; `--dangerously-skip-permissions`.

### À demander à l'humain (informations manquantes)
1. Puissance souscrite Linky (kVA) — pour le délestage (P6).
2. Liste complète des pièces + où iront capteurs et satellites.
3. Inventaire du bridge Hue (la TV est-elle une prise ? — ADR-006).
4. Source d'agenda pour le planner (Google Calendar ? autre ?).
5. ADR ouverts : 002 (modèle mmWave), 003 (HA long terme vs UI custom), 007 (moteur wake word).

## 18. ADR — état

- **ADR-001 — accepté** : chaudière pilotée via le thermostat Netatmo existant.
- **ADR-002 — ouvert** : modèle mmWave (Zigbee type ZY-M100 vs ESPHome maison).
- **ADR-003 — ouvert** : HA conservé long terme ou UI custom.
- **ADR-004 — accepté** : nom du projet : **Stellar** ; assistant vocal : « Stellar Home » ; wake word : « OK Stellar » (§12).
- **ADR-005 — accepté** : Midea via dongles d'origine + wrapper node-mideahvac ; pont série ESP32 = plan B documenté (même interface driver, seul le transport change).
- **ADR-006 — partiellement tranché** : TV = androidtv-driver via protocole Remote v2 (plus jamais coupée par une prise). Reste ouvert : nature des prises connectées (bridge Hue → P1 ; sinon Zigbee ~10 €/u en P4).
- **ADR-007 — ouvert** : moteur du wake word custom « OK Stellar » (microWakeWord on-device vs openWakeWord côté serveur).
