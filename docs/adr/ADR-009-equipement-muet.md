# ADR-009 — Sémantique « process vivant / équipement muet »

2026-08-03 · Statut : accepté

## Contexte

`home/health/<driver>` (LWT) ne connaît que online/offline et ne reflète que la
connexion **MQTT du process**. Un driver peut être online pendant que son
équipement est injoignable (TV éteinte-réseau, SK103 décroché — la spec §9
Midea exige « alerte si injoignable > 5 min »). Sans convention, chaque driver
inventera la sienne.

## Décision

Deux canaux, deux significations, pour tous les drivers :

- `home/health/<driver>` : santé du **process** uniquement (LWT). Pas de
  troisième état.
- Équipement muet : le driver republie ses entités avec **`stale: true`**
  (champ déjà prévu au contrat Entity §7) quand le lien équipement est perdu
  au-delà d'un seuil propre au driver (androidtv : dès la perte de session ;
  midea : > 5 min). Au rétablissement : republication fraîche `stale` absent.

## Conséquences

- Le miroir/le core lisent une seule convention ; l'alerte stale de P5
  s'appuiera dessus sans cas particulier.
- Un driver ne doit jamais ack `ok` une commande qu'il sait ne pas pouvoir
  transmettre (session morte → `rejected`).

## Alternatives écartées

- État `degraded` dans Health : casse le contrat LWT (le broker ne peut publier
  que le will), mélange santé process et santé équipement.
