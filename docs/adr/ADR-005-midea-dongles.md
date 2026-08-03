# ADR-005 — Clims Midea via dongles d'origine + wrapper node-mideahvac

2026-08-02 · Statut : accepté

## Contexte

3 clims Midea avec dongles WiFi d'origine (SmartKey sk103, protocole LAN
chiffré nécessitant token/key obtenus une fois via le cloud). Alternatives :
remplacer les dongles par des ponts série ESP32, ou réimplémenter le protocole.

## Décision

Garder les dongles d'origine ; transport via `packages/midea-protocol` =
wrapper typé de la lib npm `node-mideahvac` (mode sk103). On ne réimplémente le
protocole que si la lib bloque réellement.

## Conséquences

- **P4.0 urgent** : obtenir les token/key tant que le cloud Midea le permet
  (fenêtre en cours de fermeture) — voir TODO_LJ.md.
- Contraintes runtime : polling doux 30–60 s (le SK103 décroche si pollé fort),
  resynchronisation au reconnect, alerte si injoignable > 5 min.

## Alternatives écartées

- Pont série ESP32 : reste le **plan B documenté** (le dongle n'est qu'un pont
  UART) — même interface driver, seul le transport change.
- Réimplémentation du protocole : coût sans bénéfice tant que la lib marche.
