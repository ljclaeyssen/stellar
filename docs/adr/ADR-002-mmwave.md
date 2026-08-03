# ADR-002 — Modèle de capteur de présence mmWave

2026-08-02 · Statut : ouvert (à trancher avant l'achat P5)

## Contexte

La détection de présence par pièce (personne immobile) exige du mmWave, le PIR
ne suffit pas. Deux familles : capteurs Zigbee tout faits (type ZY-M100, ~25 €)
ou capteurs ESPHome maison (LD2410 + ESP32, plus configurables).

## Décision

À trancher avec l'humain avant l'achat P5. Critère spec : « Zigbee d'abord »
(règle n°8) — le ZY-M100 arrive par Z2M déjà en place ; l'option ESPHome
ajouterait une plateforme.

## Conséquences

Sans impact sur le code : dans les deux cas le percept arrive par le
z2m-normalizer (Zigbee) ou par un mini-driver (ESPHome), kind `presence`.

## Alternatives écartées

(aucune pour l'instant)
