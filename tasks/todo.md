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
