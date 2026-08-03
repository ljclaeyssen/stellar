# ADR-003 — Home Assistant conservé long terme ou UI custom

2026-08-02 · Statut : ouvert (à trancher après P8)

## Contexte

HA n'est utilisé que comme plomberie vocale (Assist/Wyoming) et UI de secours
(app mobile via le pont HA-discovery). Aucune logique n'y vit (interdit absolu).
Question : à terme, garder HA pour ça ou écrire une UI custom (le stack tRPC/WS
du core P5 s'y prête) ?

## Décision

Reportée : on vivra avec HA allégé pendant P8, la décision se prendra sur
l'usage réel.

## Conséquences

Le pont HA-discovery (P8) doit rester strictement unidirectionnel et jetable.

## Alternatives écartées

(aucune pour l'instant)
