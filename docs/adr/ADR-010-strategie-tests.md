# ADR-010 — Stratégie de test : coutures, simulateurs, banc d'essai

2026-08-03 · Statut : accepté

## Contexte

Les phases P2–P9 doivent être développées sans le matériel (Hue, Netatmo,
Midea, Zigbee, satellites), avec la garantie qu'au branchement réel tout
fonctionne — demande explicite de l'humain (session 2026-08-03).

## Décision

Trois niveaux, décrits en détail dans `docs/TESTING.md` :

1. **Couture interne par driver** : chaque driver dépend d'une interface de
   transport (`TvRemoteLike`, `HueApiLike`, …) doublée en test.
2. **Simulateurs de périphériques** (`apps/simulators/*`) : petits process Node
   imitant l'API/le protocole (sim-hue CLIP v2 + SSE, sim-netatmo OAuth,
   sim-tempo, sim-midea au niveau wrapper, sim-z2m rejouant des fixtures),
   utilisables dans les tests ET à la main.
3. **Banc d'essai** : broker + drivers simulés + core + runner de scénarios
   déclaratifs (`apps/testbench`) — les DoD des phases passées restent des
   scénarios vivants exécutés en CI.

Non-régression : snapshot des JSON Schemas des contrats, golden tests de
régulation à horloge injectée (P6), `pnpm check` unique. Branchement matériel :
checklist par driver (IP fixe → pairing/token sops → `verify` lecture seule +
enregistrement fixtures → recalage simulateur → DoD).

## Conséquences

- Un simulateur se recale sur les fixtures réelles dès qu'elles existent
  (`__fixtures__/`, règle spec §17).
- Les tests de protocole MQTT 5 (properties) restent non couverts par aedes ;
  une suite optionnelle contre mosquitto réel est prévue au banc d'essai.

## Alternatives écartées

- Réimplémenter les protocoles dans les simulateurs (sim-midea protocole
  chiffré, sim-androidtv TLS) : coût disproportionné, la couture niveau lib
  suffit — cohérent avec ADR-005.
