# ADR-007 — Moteur du wake word custom « OK Stellar »

2026-08-02 · Statut : ouvert (à trancher pendant P8)

## Contexte

Le Voice PE embarque microWakeWord (on-device, ESP32-S3) ; openWakeWord tourne
côté serveur (N100) avec plus de puissance mais du trafic audio permanent.

## Décision

À trancher pendant P8, après essais réels : microWakeWord on-device (privé,
zéro trafic, entraînement plus contraint) vs openWakeWord serveur (itérations
d'entraînement plus faciles, audio streamé en continu vers le N100).

## Conséquences

Le bring-up P8 se fait sur le wake word intégré « Okay Nabu » — la décision ne
bloque aucun DoD.

## Alternatives écartées

(aucune pour l'instant)
