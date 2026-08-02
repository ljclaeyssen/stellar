# P0 — Socle

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
