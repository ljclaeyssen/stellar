# ADR-006 — TV via protocole Android TV Remote v2 ; nature des prises à trancher

2026-08-02 · Statut : partiellement tranché

## Contexte

La TV Android TV était historiquement coupée par une prise connectée (violent
pour l'électronique, empêche le réveil réseau). Il faut un contrôle propre :
power, lancement d'app, touches, volume.

## Décision

- TV = androidtv-driver via **protocole Remote v2** (TLS, pairing par code
  écran, lib `@kud/androidtv-remote`). La TV n'est **plus jamais** alimentée via
  une prise pilotée ; veille réseau activée, IP fixe.
- Reste ouvert : nature des prises connectées du foyer (si sur le bridge Hue →
  P2 ; sinon prises Zigbee ~10 €/u en P4/P5).
- Avancée P2 (2026-08-03) : CLIP v2 expose les prises comme ressources `light`
  d'archetype `plug` — le hue-driver les publie en kind `plug` (repli sur
  l'archetype du device pour les firmwares qui ne le posent que là). À
  confirmer sur l'inventaire réel au premier `stellar-hue verify`.

## Conséquences

- Percept `media` (`tv_salon`) : `{power, currentApp, volume}`.
- Le pairing produit un certificat TLS = secret (sops).

## Alternatives écartées

- ADB : fragile, ouvre un accès shell complet à la TV.
- HDMI-CEC : dépend du matériel intermédiaire, pas de launch_app.
