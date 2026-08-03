# ADR-001 — Chaudière pilotée via le thermostat Netatmo existant

2026-08-02 · Statut : accepté

## Contexte

Le chauffage central gaz est commandé par un thermostat Netatmo déjà installé et
fonctionnel. Le remplacer (relais Zigbee direct sur la chaudière) donnerait un
contrôle plus direct mais toucherait au matériel safety-adjacent.

## Décision

La chaudière est pilotée exclusivement à travers le thermostat Netatmo
(consigne + mode via l'API), jamais en direct. Le netatmo-driver (P3) expose
`thermostat_maison` (kind `climate`).

## Conséquences

- Dépendance au cloud Netatmo pour l'écriture de consigne (assumée : le
  thermostat garde sa consigne locale si le cloud tombe — la maison continue).
- La régulation (P6) choisit entre PAC et « central » sans connaître Netatmo.

## Alternatives écartées

- Relais direct sur la chaudière : risque, câblage, perte des sécurités du
  thermostat d'origine.
