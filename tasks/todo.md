# Audit croisé 2026-08-03 (2 Fable + 2 Opus) — soldé

- 4 angles : conformité spec, bugs/robustesse, qualité/tests/DX, sécu/ops.
  Rapports condensés dans le scratchpad de session ; corrections en 2 vagues
  (commits 992f9ea → 27d5e4d). Tout le « top 5 » de chaque rapport est traité.
- Reste ouvert (assumé) : sonde de vivacité TV pour le cas EHOSTDOWN sans signal
  (à revoir en P5 avec la détection stale du core) ; suite de tests MQTT 5
  properties contre mosquitto réel (prévue au banc d'essai, ADR-010) ; auth/ACL
  mosquitto à trancher en P5 (note dans mosquitto.conf).

---

# P9 — Prédictif + extensibilité (DoD simulé atteint le 2026-08-04 — SPEC COUVERTE)

- [x] Occupation probabiliste (apps/core/src/predictive) : modèle inspectable
      (comptages Laplace par pièce/type de jour/créneau 30 min, formatProfile
      relisible), exclusion des republis stale, ts du payload (pas de pic au
      redémarrage), carry-forward intra-journée, undefined ≠ « probablement
      vide » ; cache 1 h ; 25 tests
- [x] Préconditionnement : consigne relevée bornée min(present, absent+delta),
      gardes dans l'ordre délestage > rouge HP > pas de cumul avec préchauffe
      Tempo ; golden 07 en 3 actes (bleu → chauffe anticipée ; rouge HP → refus
      visible ; rouge HC → pas de cumul) ; goldens 01-06 inchangés à l'octet ;
      enabled:false par défaut (activer après ~4 semaines de journal — TODO_LJ)
- [x] PR partagée cover (spec §7) : CoverValue aux contrats, MCP n'interdit plus
      que lock/button/doorbell, pont HA mappe cover (position + verbes JSON)
- [x] apps/drivers/fake-shutter : driver ordinaire complet (machine d'état
      progressive, 8 tests)
- [x] **Test d'acceptance §13** (p9-extensibilite.spec) : core complet démarré
      ignorant → driver branché à chaud → visible dans list_capabilities,
      piloté par MCP (issued_by agent) ET par HA (issued_by voice), ET
      grep auto-vérifiant : aucune source de core/agent ne nomme le driver
- [x] `pnpm bench` : maison simulée complète (sims + drivers + core) pour
      exploration manuelle ; `check:p9`

---

# P8 — Voix (partie logicielle livrée le 2026-08-04 — satellites/HA réels humains)

- [x] Pont HA-discovery (apps/core/src/ha-bridge) : table kind→composant HA
      exhaustive par `satisfies` (un nouveau kind casse la compil tant que HA
      n'est pas décidé), configs retained dédupliquées + effacement, commandes
      HA en **JSON** (pas ON/OFF — le dispatch bus reste propre) traduites en
      Command issuedBy 'voice' via le miroir, availability sur home/health,
      stale/room en attributs, device par pièce (intents « salon ») ; lock &
      réservés jamais publiés ni pilotables (testé) ; 11 tests dont HA-démarre-
      après-le-core (retained)
- [x] Infra voix : docker-compose.voice.yml (HA + whisper fr + piper fr),
      configuration.yaml plomberie pure (MQTT/Wyoming = config-flow UI,
      documenté), custom component stellar_conversation (~plomberie → POST
      /turn de l'agent ; relu non exécuté — bring-up N100)
- [x] `check:p8` ; DoD matériel (minuteur < 1 s, multi-tours, annonce planner)
      dans TODO_LJ

---

# P7 — MCP + Agent v1 (DoD simulé atteint le 2026-08-04)

- [x] Serveur MCP core : 7 tools (get_state, send_command issuedBy=agent forcé + refus lock/kinds réservés, subscribe/poll borné FIFO+TTL,
      list_capabilities, query_journal strict, get_regulation_config lecture
      seule), HTTP streamable loopback, chaque appel loggé ; 16 tests dont
      double preuve d'absence sur les kinds interdits
- [x] apps/agent : sessions éphémères query() du Claude Agent SDK (couture
      queryFn → testable sans LLM), allowlist 3 couches (tools socle réduit,
      allowedTools nominatif, disallowedTools + settingSources:[] +
      strictMcpConfig), system prompt vocal « Stellar Home », market_quote
      provider pluggable (fake par défaut), propose_regulation_change →
      config/proposals/ + événement bus + apply CLI à confirmation (jamais
      d'écriture de regulation.yaml — testé aux octets), planner du matin
      (prompt construit sur le MCP réel), budget/usage quotidien loggé,
      service HTTP /turn + /planner/run (future prise HA P8) ; 27 tests
- [x] Dérive de noms de tools couverte : le test compare l'allowlist aux tools
      réellement servis par le core vivant
- [x] Units systemd agent + planner.timer (infra/systemd/) ; `check:p7`
- Notes : SDK réclame zod ^4 en peer (v3 accepté par AnyZodRawShape — à revoir
  à la migration zod 4) ; MARKET_PROVIDER n'a que `fake` (choix humain TODO_LJ).

---

# P6 — Tempo + régulation (DoD simulé atteint le 2026-08-04)

- [x] tempo-driver + sim : RTE OAuth + fallback opendata sans compte, wrap du
      jour Tempo à 6 h, republication HP/HC à l'heure juste, DST Europe/Paris,
      stale 2 cycles, verify sans secret ; smoke test sim + CLI réels (32 tests)
- [x] régulation core : `decide` pur + runtime fin ; hystérésis ±0,4, modes
      present/absent/nuit, politique Tempo (rouge HP → chaudière, préchauffe
      02:00 HC, blanc HP/HC, bleu libre), délestage ordonné + réarmement
      inverse, anti-court-cycle 5 min, fallback capteur stale → hors_gel,
      driver offline → silence + alerte ; config/regulation.yaml zod strict
- [x] **6 golden tests** journée type relisibles (01-journee-bleue …
      06-driver-offline) + 12 tests d'intégration runtime sur broker (routage
      ADR-008 prouvé, dedup, causes, échec d'ack)
- [x] Correctif post-revue : un ack rejected/timeout part désormais AUSSI dans
      l'événement regulation (`commandFailure`) — relisible dans le journal,
      pas seulement dans les logs
- [x] Flake résolu pour de bon : le test de jitter comparait des SOMMES de 4
      tirages (collision fréquente) → comparaison de séquences de 8 ; 5 runs
      complets de stress verts
- [x] `check:p6` ; 309 tests au global
- Notes : `evaluate()` publique non sérialisée avec les tours internes
  (documenté — à surveiller quand le MCP P7 l'exposera) ; kVA réel et compte
  RTE attendus côté humain (TODO_LJ).

---

# P5 — Serveur + percepts (DoD simulé atteint le 2026-08-03 — matériel N100/Zigbee humain)

- [x] core : journal SQLite (§10 exact, « un fait pas une opinion »), stale
      watcher mort-silencieuse (horloge injectée, ts d'origine conservé,
      idempotent, complément ADR-009), API tRPC+WS un port (AppRouter exporté),
      createCore assemblé, 45 tests dont p5-dod
- [x] z2m-normalizer : table déclarative config/z2m-mapping.json (9 entités,
      FieldRef avec scale par champ), availability 2 formats → stale, silence ≠
      stale (rôle du core), dump de recalage, 26 tests
- [x] sim-z2m publisher MQTT ; fix bus : topics hors home/ ignorés du dispatch
- [x] check racine vert (258 tests) ; zod ajouté au core (validation API)

---

# P4 — Clims Midea (DoD simulé atteint le 2026-08-03 — atelier tokens P4.0 humain en attente)

- [x] `packages/midea-protocol` : couture typée calée sur node-mideahvac 0.3.3
      RÉEL (mode/fanSpeed en {value,description} aplatis, asymétrie
      lecture/écriture des modes, pas d'événements en sk103 → panne détectée aux
      rejets de getStatus, pas de session persistante), fake appliance publique,
      mapping status ↔ ClimateValue (102→'auto', 101→'fixed' lisible non
      écrivable), fixtures
- [x] `apps/drivers/midea` : 3 unités, polling doux 45 s + jitter ±10 %
      (désynchronise les dongles), climate + percept temperature par unité,
      set (resync par le retour de setStatus, anti-martèlement), verify sans
      secrets, stale ADR-009 en cycles (plancher 2, ≈5 min en prod)
- [x] 42 tests ; chasse à un flake sous charge parallèle : course légitime
      commande/poll rendue tolérante dans le spec anti-martèlement, `retry: 1`
      en CI uniquement (vitest.shared) ; 25 runs complets verts consécutifs
- [x] `check:p4` ; check racine vert (197 tests)

---

# P3 — Chauffage Netatmo (DoD simulé atteint le 2026-08-03)

- [x] `apps/simulators/netatmo` : OAuth à rotation stricte, Energy + Station,
      helpers de panne (expire/revoke/failNext)
- [x] `apps/drivers/netatmo` : TokenStore atomique (tmp+rename, refresh sérialisé,
      relecture du fichier en retry doux → l'humain peut réamorcer sans
      redémarrage), polling 2 cadences, thermostat_maison (climate, mapping modes
      documenté) + percepts station, set targetTemp/mode (auto+targetTemp rejeté),
      verify, stale ADR-009 (2 cycles ratés ; mesure vieille → stale, jamais
      supprimée — fallback pour le core)
- [x] 36 tests niveau 2 verts ; check racine vert (155 tests) ; `check:p3`

---

# P2 — Lumières & prises (DoD simulé atteint le 2026-08-03)

## Todo

- [x] `apps/simulators/hue` (@stellar/sim-hue) : CLIP v2 simulé (light/device/room,
      PUT + event SSE, pairing link button), lançable seul, état = fixtures
- [x] `apps/drivers/hue` : couture HueApiLike (REST + SSE + reconnexion 1 s→30 s),
      mapping inventaire → entités (light_<room>_<nom> / plug_<nom>), driver
      (SSE → state, cmd set → PUT → ack 2xx), pair (boucle 101), verify (dump
      fixtures + résumé), main run/pair/verify
- [x] Tests niveau 2 contre le simulateur : 29 verts — **ack mesuré 5,6 ms**
      (DoD < 300 ms), stale + rejet bridge down, resync complet au retour
- [x] `pnpm check` racine vert (119 tests) + `check:p2`

## Review

- Le SSE est la sonde de vie du bridge (ADR-009) ; retour → ré-inventaire complet
  (une lampe a pu être renommée pendant la coupure). Inventaire initial
  best-effort : bridge éteint au démarrage ≠ crash, self-healing à l'onUp.
- Prises : CLIP v2 les expose en `light` archetype `plug` → kind `plug`
  (ADR-006 avancé, à confirmer au verify réel).
- Dette consciente : une lampe supprimée du bridge laisse un retained fantôme —
  il manque un `deleteState` au Bus (symétrique d'onStateDeleted). **À traiter
  en P5** avec le miroir/journal.
- Scission tsconfig lint/build faite pour hue (plafond allowDefaultProject) —
  les prochains drivers font pareil.
- DoD matériel : checklist TODO_LJ (pair → verify → run).

---

# P1 — La télé

Plan (spec §16 + §9 androidtv-driver). DoD : « lance Netflix » de bout en bout via
`home/cmd` (TV réveillée + app ouverte) — la validation finale exige la TV réelle
(pairing par code écran) → partie humaine dans TODO_LJ.md.

## Todo

- [x] `apps/drivers/androidtv` : driver traducteur pur sur `@kud/androidtv-remote` 0.1.2
      (power, launch_app, key, volume, send_text ; events → percept `media` tv_salon)
- [x] Pairing interactif (`stellar-androidtv pair`, code affiché à l'écran) → cert JSON
      gitignoré (sops à brancher)
- [x] Manifeste discovery + health LWT + logs JSON (règles communes drivers)
- [x] Tests : mapping Command→remote et events→Entity avec un FakeRemote (8 tests)
- [x] `apps/core` : miroir minimal — states par sélecteurs + agrégat manifestes
      discovery + santé drivers (4 tests)
- [x] `pnpm check:p1` + CI mise à jour
- [x] TODO_LJ.md : étapes humaines (veille réseau TV, IP fixe, pairing, Midea P4.0)

## Review

- `pnpm check:p1` vert : build + lint + typecheck + 32 tests (contracts 14, bus 6,
  androidtv 8, core 4).
- Le test « DoD » du driver rejoue « lance Netflix » : commande `launch_app` sur
  `home/cmd/androidtv/tv_salon` → TV réveillée (`sendPower`) + deep link Netflix envoyé,
  ack ok ; les events du protocole alimentent le percept `media` retained.
- **La validation finale du DoD exige la TV réelle** (pairing par code écran) —
  étapes humaines dans TODO_LJ.md ; ensuite : `ATV_HOST=<ip> stellar-androidtv pair`
  puis `run`, et `stellar cmd androidtv tv_salon launch_app '{"app":"netflix"}'`.
- Choix notables :
  - `power` traduit l'intention on/off vers le `sendPower()` toggle de la lib en
    s'appuyant sur l'état connu (traduction, pas de logique métier).
  - `launch_app` réveille la TV si elle est éteinte (exigence du DoD).
  - Reconnexion : restart de session avec backoff 5 s → 60 s sur erreur protocole ;
    `unpaired` → exit(1) explicite (re-pairing requis).
  - Fix au passage dans le logger bus : les champs réservés ts/level/driver/msg ne
    peuvent plus être écrasés par les champs extra.
- Fixtures de trames réelles (spec) : non applicables ici — on s'appuie sur la lib
  maintenue `@kud/androidtv-remote` (protocole protobuf TLS) ; des fixtures d'events
  réels pourront être enregistrées à la première connexion à la vraie TV.

---

# P0 — Socle (validée 2026-08-02)

Plan d'exécution (spec §16, DoD : fake-driver publie un state typé validé par un fake-consumer ; `pnpm test` vert ; `pnpm check:p0`).

## Todo

- [x] git init, déplacer SPEC.md → docs/SPEC.md
- [x] Scaffold monorepo : package.json racine, pnpm-workspace.yaml, tsconfig.base, eslint+prettier, .gitignore
- [x] `packages/contracts` : Kind, schémas de value par kind, Entity, Command, Ack, Manifest, Event, Health, helpers topics, export JSON Schema (zod-to-json-schema), tests unitaires (14)
- [x] `packages/bus` : createBus (LWT, backoff expo, health online), publishState/onState(selector), sendCommand/onCommand (MQTT5 resp-topic + fallback home/ack), publishEvent/onEvent, announce, logger JSON ; tests d'intégration aedes (6)
- [x] Test e2e DoD : fake-driver publie un state typé + manifeste, fake-consumer valide via contracts, aller-retour commande→ack (`packages/bus/src/p0-dod.spec.ts`)
- [x] `infra/docker-compose.yml` : mosquitto + config (persistence pour retained) — `docker compose config` OK
- [x] `apps/cli` squelette : `states`, `cmd`, `health`
- [x] CI GitHub Actions : install + `pnpm check:p0`
- [x] Script `pnpm check:p0` (build + lint + typecheck + test) — vert
- [x] Commits conventionnels petits au fil de l'eau

## Notes

- P4.0 (atelier tokens Midea) est signalé « faisable dès aujourd'hui, avant même P0 » dans la spec, mais nécessite le compte SmartHome de l'humain + le LAN de la maison → à faire par l'humain, rappel dans le résumé de session.
- aedes ne supporte que partiellement MQTT 5 → tests bus en protocolVersion 4, le fallback `home/ack/<commandId>` couvre ; mosquitto réel = MQTT 5.

## Review

- DoD P0 atteint : `pnpm check:p0` vert (build + lint + typecheck + 20 tests). Le test
  `packages/bus/src/p0-dod.spec.ts` matérialise le DoD : fake-driver → manifeste discovery
  retained + state `climate` typé retained → fake-consumer le valide par sélecteur
  `{kind, room}` ; aller-retour commande→ack ; timeout ; rejet des payloads invalides ;
  LWT online/offline.
- Choix d'implémentation notables (dans le cadre de la spec, pas d'ADR nécessaire) :
  - `sendCommand(cmd, {driver})` : le driver destinataire est passé en option — le topic
    `home/cmd/<driver>/<entityId>` l'exige, et c'est l'appelant (le core via son miroir)
    qui le résout ; la règle « pas de nom de driver dans la logique » reste intacte.
  - aedes ne supporte MQTT 5 que partiellement → tests en protocolVersion 4 ; le
    req/resp repose alors sur le fallback `home/ack/<commandId>` (prévu par la spec §6).
    Contre mosquitto réel, protocolVersion 5 + response-topic sont actifs par défaut.
  - Backoff expo de reconnexion implémenté par ajustement de `reconnectPeriod` mqtt.js
    (1 s → 30 s max), reset à la reconnexion.
- Non testé en réel : mosquitto via docker (daemon Docker arrêté pendant la session) ;
  `docker compose config` validé. À faire au premier démarrage : `docker compose -f
infra/docker-compose.yml up -d` puis `stellar states --follow`.
- Reste à l'humain : valider la phase (mettre à jour « Phase en cours » dans CLAUDE.md),
  et surtout **P4.0 atelier tokens Midea** (spec §9/§16 : « faisable dès aujourd'hui,
  la fenêtre cloud se referme ») — nécessite le compte SmartHome + le LAN de la maison.
