# TESTING — garantir le fonctionnement sans le matériel

> Objectif : développer **toutes** les phases sans toucher au matériel, avec une
> confiance suffisante pour que le branchement réel (TV, Hue, Netatmo, Midea,
> Zigbee) soit une formalité : pairing/token, `verify`, enregistrement des
> fixtures, fin.

## 1. Les trois niveaux de test

### Niveau 1 — la couture interne (unit/intégration par package)

Chaque driver dépend d'une **interface de transport** (couture), jamais
directement du matériel :

| Driver         | Couture                                                   | Faux utilisé en test                          |
| -------------- | --------------------------------------------------------- | --------------------------------------------- |
| androidtv      | `TvRemoteLike` (sous-ensemble de `@kud/androidtv-remote`) | `FakeRemote` (EventEmitter)                   |
| hue            | client CLIP v2 (`HueApiLike` : REST + flux SSE)           | serveur HTTP simulé (niveau 2)                |
| netatmo        | client API OAuth (`NetatmoApiLike`)                       | serveur HTTP simulé (niveau 2)                |
| midea          | wrapper `packages/midea-protocol` (`MideaClientLike`)     | fake au niveau du wrapper                     |
| tempo          | client API RTE                                            | serveur HTTP simulé (niveau 2)                |
| z2m-normalizer | topics `zigbee2mqtt/#` sur le bus                         | publication de fixtures sur le broker de test |

Le bus lui-même se teste contre **aedes** (broker MQTT en mémoire, protocole 4,
le fallback `home/ack` couvrant le req/resp). Les invariants du contrat
(« message invalide → jeté et loggé ») sont testés à chaque frontière.

### Niveau 2 — simulateurs de périphériques (`apps/simulators`)

Des petits process Node **réutilisables dans les tests et lançables à la main** :

- `sim-hue` : serveur HTTPS imitant CLIP v2 (ressources light/plug, event stream
  SSE, application key) ; état interne mutable → répond aux PUT et pousse les
  events correspondants.
- `sim-netatmo` : serveur HTTP imitant l'API (OAuth refresh compris, pour tester
  la rotation de refresh token — le point fragile identifié par la spec).
- `sim-tempo` : serveur HTTP renvoyant des couleurs Tempo contrôlables (bleu /
  blanc / rouge / bascule à 11 h).
- `sim-midea` : fake du wrapper (pas du protocole chiffré — on simule au niveau
  de `packages/midea-protocol`, conformément au choix ADR-005 de ne pas
  réimplémenter le protocole).
- `sim-z2m` : rejoue sur le broker des messages `zigbee2mqtt/<friendly_name>`
  enregistrés en fixtures (capteurs T°, mmWave, ZLinky), avec pilotage du rythme.
- `sim-androidtv` : optionnel (la couture FakeRemote suffit) — si besoin d'un
  vrai bout TLS un jour, il rejouera les fixtures protobuf enregistrées.

Règle : **un simulateur rejoue des fixtures réelles dès qu'elles existent**
(`__fixtures__/`, règle de la spec §17). Avant le premier contact matériel, il
rejoue des payloads issus de la documentation du protocole ; après, on recale.

### Niveau 3 — banc d'essai complet (e2e simulé)

`infra/docker-compose.sim.yml` (profil « sim ») : mosquitto réel + tous les
drivers branchés sur leurs simulateurs + core + cli. Un runner de scénarios
(`apps/testbench`) déroule des scénarios déclaratifs :

```yaml
# scenario: lance-netflix
steps:
  - cmd: { driver: androidtv, target: tv_salon, action: launch_app, params: { app: netflix } }
  - expectAck: ok
  - expectState: { id: tv_salon, value: { power: true, currentApp: com.netflix.ninja } }
```

Ces scénarios tournent aussi en CI (broker aedes ou mosquitto service GitHub
Actions). C'est la répétition générale permanente du système complet.

## 2. Non-régression

1. **`pnpm check:pN` cumulatif** : le check de la phase N exécute tout (build,
   lint, typecheck, tests de tous les packages). La CI le rejoue à chaque push.
2. **Snapshot des contrats** : les JSON Schemas exportés (Entity, Command, Ack,
   Manifest, values par kind) sont snapshotés dans les tests de
   `packages/contracts`. Toute évolution de contrat casse la CI et doit être
   assumée dans la PR (règle spec : une famille d'objets = une PR partagée).
3. **Golden tests de régulation (P6)** : la régulation est déterministe, avec
   horloge injectée. Scénarios « journée type » (tempo rouge, capteur stale,
   délestage, anti-court-cycle) → suites de décisions attendues, relues
   textuellement. Tout changement de comportement devient un diff visible.
4. **Scénarios e2e simulés** (niveau 3) en CI : les DoD des phases passées
   restent exécutés (le DoD P1 « lance Netflix » reste un test vivant).

## 3. Checklist de branchement matériel (le jour J, par driver)

1. IP fixe réservée (bail DHCP).
2. Pairing/token via la commande dédiée du driver (`pair`, procédure OAuth,
   atelier Midea P4.0) — secrets aussitôt chiffrés sops/age.
3. `stellar-<driver> verify` : mode miroir qui se connecte au matériel réel,
   **enregistre les trames/états reçus en fixtures** et les valide contre les
   contrats — sans rien piloter.
4. Comparaison fixtures réelles ↔ simulateur ; recalage du simulateur si écart.
5. Lancement du driver en réel, `stellar states --follow` pour observer,
   première commande inoffensive (ex. `key KEYCODE_INFO`), puis DoD de la phase.

Chaque étape est reportée dans TODO_LJ.md par phase.

## 4. Ce que ça garantit (et ce que ça ne garantit pas)

- ✅ La logique complète (traduction drivers, miroir, régulation, MCP, agent)
  est exercée en continu, y compris les chemins d'erreur (timeout, payload
  invalide, driver offline, capteur stale).
- ✅ Zéro régression silencieuse : contrats snapshotés, DoD vivants, CI.
- ⚠️ Ne garantit pas : les particularités du matériel réel (firmwares, timing,
  bugs de bridge). C'est le rôle de l'étape `verify` + fixtures réelles du
  jour J — le code qui les consomme, lui, est déjà éprouvé.
