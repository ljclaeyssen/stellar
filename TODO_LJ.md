# TODO LJ — actions qui nécessitent l'humain

## ⚠️ P4.0 — Atelier tokens Midea (URGENT, la fenêtre cloud se referme)

Midea ferme progressivement ses API cloud de délivrance token/key (Meiju et SmartHome
déjà fermées côté nouvelles apps, NetHome Plus en sursis). Les appareils déjà
provisionnés continuent en local à vie — c'est **l'obtention** des tokens qui a une
date de péremption inconnue. À faire dès qu'un créneau se libère, depuis le LAN de la
maison (spec §9 midea-driver) :

1. Réserver des IP fixes (baux DHCP statiques) pour les 3 dongles des clims
   (salon, entree, chambre).
2. Depuis le Mac ou la tour (PAS depuis Docker/VM — le discovery est un broadcast UDP) :
   ```bash
   npx node-mideahvac
   midea-discover --user=<email-compte-SmartHome> --password=<mdp>
   ```
   → noter **id / token / key / IP** pour chacune des 3 unités.
3. Plan B si l'étape 2 échoue : `pipx install msmart-ng` (CLI équivalent, comptes
   intégrés disponibles).
4. Me donner les résultats en session → j'archive le tout chiffré (sops/age) dans
   `config/` — c'est l'assurance-vie du parc de clims.

## P1 — La télé (pour valider le DoD)

- Activer la **veille réseau** sur la TV Android TV (ne jamais la couper par une prise).
- Réserver une IP fixe pour la TV (bail DHCP statique) et me la donner.
- Lancer le pairing (code affiché à l'écran de la TV) quand le driver sera prêt —
  procédure guidée fournie par le driver.

## Infos manquantes (spec §17, à me donner quand tu les as)

1. Puissance souscrite Linky (kVA) — nécessaire au délestage (P6).
2. Liste complète des pièces + emplacement prévu des capteurs et satellites.
3. Inventaire du bridge Hue — la TV est-elle branchée sur une prise connectée ? (ADR-006)
4. Source d'agenda pour le planner du matin (Google Calendar ? autre ?).
5. ADR ouverts à trancher : 002 (modèle mmWave), 003 (HA long terme vs UI custom),
   007 (moteur wake word).

## Premier démarrage réel de l'infra (validation P0 en conditions réelles)

```bash
docker compose -f infra/docker-compose.yml up -d
node apps/cli/dist/main.js states --follow
```
