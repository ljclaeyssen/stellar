# TODO LJ — actions qui nécessitent l'humain

## 🔴 Sauvegarde du dépôt (priorité haute, 5 min)

Le dépôt n'a **aucun remote** aujourd'hui : tout Stellar tient sur un seul disque.
Créer un repo git **privé** sur GitHub et pousser — c'est le seul backup du projet.

```bash
gh repo create stellar --private --source=. --remote=origin --push
# ou : git remote add origin git@github.com:<toi>/stellar.git && git push -u origin main
```

Le `.gitignore` est en allowlist sur `config/` : rien n'y est versionné sauf
`regulation.yaml` et les `*.enc.yaml` / `*.enc.json` chiffrés. Pousser est sûr.

## 🔑 Sops/age — à initialiser (avant l'atelier Midea !)

Sans ça, les tokens Midea récoltés à l'étape suivante n'ont nulle part où aller
(spec §14 : aucun secret en clair, jamais commité déchiffré).

1. **Installer sops + age**
   ```bash
   winget install FiloSottile.age Mozilla.SOPS   # tour Windows
   brew install sops age                         # MacBook
   ```
2. **Générer la clé**
   ```bash
   age-keygen -o ~/.config/sops/age/keys.txt
   ```
3. **Sauvegarder la clé privée hors ligne** — gestionnaire de mots de passe **+**
   copie papier. **JAMAIS dans git.** Cette clé perdue = tous les secrets chiffrés
   du dépôt définitivement illisibles (tokens Midea inclus, et ils ne sont plus
   réémissibles — voir la section suivante).
   ⚠️ Les deux machines de dev (Mac + Windows) doivent avoir la clé : soit la même
   clé recopiée, soit deux clés publiques listées dans `.sops.yaml`.
4. **Coller la/les clé(s) publique(s)** (`age1...`, affichée par `age-keygen`) dans
   `.sops.yaml` à la racine, à la place du `# TODO_LJ:`.
5. **Chiffrer le certificat TV déjà présent** puis supprimer le clair :
   ```bash
   sops -e config/androidtv-cert.json > config/androidtv-cert.enc.json
   rm config/androidtv-cert.json
   ```

Raccourcis disponibles à la racine (package.json) :
`pnpm secrets:encrypt <fichier>` (chiffre **en place**, `sops -e -i`) et
`pnpm secrets:decrypt <fichier>` (déchiffre **sur stdout**, ne touche pas au fichier).

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
