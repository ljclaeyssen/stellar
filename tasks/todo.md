# Audit croisé 2026-08-03 (2 Fable + 2 Opus) — soldé

- 4 angles : conformité spec, bugs/robustesse, qualité/tests/DX, sécu/ops.
  Rapports condensés dans le scratchpad de session ; corrections en 2 vagues
  (commits 992f9ea → 27d5e4d). Tout le « top 5 » de chaque rapport est traité.
- Reste ouvert (assumé) : sonde de vivacité TV pour le cas EHOSTDOWN sans signal
  (à revoir en P5 avec la détection stale du core) ; suite de tests MQTT 5
  properties contre mosquitto réel (prévue au banc d'essai, ADR-010) ; auth/ACL
  mosquitto à trancher en P5 (note dans mosquitto.conf).

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
