# ADR-004 — Nom du projet, de l'assistant et wake word

2026-08-02 · Statut : accepté

## Contexte

Il faut un nom de projet, un nom d'assistant vocal parlé, et un wake word
custom entraînable (openWakeWord/microWakeWord, 4 syllabes = bon candidat).

## Décision

Projet : **Stellar**. Assistant : « Stellar Home ». Wake word : **« OK
Stellar »** (bring-up P8 sur « Okay Nabu », bascule une fois le modèle validé —
jamais bloquant pour le DoD).

## Conséquences

- L'agent se présente comme « Stellar Home » et répond en français.
- L'entraînement openWakeWord étant anglophone, prononciation à l'anglaise plus
  fiable ; faux positifs à tester en réel (ADR-007 pour le moteur).

## Alternatives écartées

Réutiliser « Alexa »/« Jarvis » : collisions, marques, faux positifs.
