# CLAUDE.md — Stellar

Domotique homemade pilotée par agent. **Lis `docs/SPEC.md` en intégralité avant toute action.** C'est la source de vérité : principes, contrats, phases, DoD.

## État courant

- Phase en cours : **toutes les phases P0→P9 sont livrées en simulé** (P0 le 2026-08-02, P1-P5 le 2026-08-03, P6-P9 le 2026-08-04). Les DoD matériels restent à valider phase par phase — checklists dans TODO_LJ.md.
- Mode de travail (demande humaine du 2026-08-03) : développement sur simulateurs (`docs/TESTING.md`, ADR-010) ; chaque DoD matériel est remplacé par un DoD simulé + une checklist de branchement dans TODO_LJ.md. Banc d'essai complet : `pnpm bench` (mosquitto docker requis).
- (Mettre à jour cette ligne à chaque phase validée.)

## Règles de travail

- **Une phase à la fois.** Ne jamais anticiper la phase suivante sans demande explicite. Chaque session commence par « on attaque/continue la phase Pn ».
- Toute décision structurante → ADR court dans `docs/adr/` **avant** le code.
- Trames et réponses matérielles réelles enregistrées en fixtures (`__fixtures__/`) avant d'implémenter un protocole.
- Commits conventionnels, petits. Une phase se valide par `pnpm check:pX` (à créer avec la phase).
- TypeScript strict, pnpm workspaces, vitest, zod à chaque frontière de process.

## Interdits absolus

- Logique métier dans un driver (les drivers traduisent, `apps/core` décide).
- Référencer un driver par son nom dans `apps/core` ou `apps/agent` — uniquement des sélecteurs `kind` + `room`.
- Dépendance à Home Assistant ou HACS pour la logique.
- Contrôle par l'agent de tout ce qui est `lock`/sécurité (serrures, alarmes, incendie).
- Secret en clair (tout passe par sops/age).
- `--dangerously-skip-permissions`, en dev comme en prod.

## Architecture en une minute

- **Bus MQTT (Mosquitto)** = colonne vertébrale : `home/state/…` (retained), `home/cmd/…` + ack, `home/event/…`, `home/discovery/…` (manifestes), `home/health/…` (LWT).
- **Drivers** (`apps/drivers/*`) : traducteurs purs, un process chacun — hue (CLIP v2 local), netatmo (OAuth), midea (LAN sk103 via wrapper node-mideahvac), tempo (API RTE), z2m-normalizer (mapping Zigbee2MQTT).
- **Core** (`apps/core`) : miroir d'état, journal SQLite, régulation déterministe (thermostats, politique Tempo, délestage), serveur MCP, pont HA-discovery.
- **Agent** (`apps/agent`) : Claude Agent SDK en sessions éphémères, tools = MCP core + WebSearch/WebFetch + market_quote + propose_regulation_change. Ne modifie que `config/regulation.yaml`, après confirmation humaine.
- **Voix** (P8) : satellites Voice PE → HA allégé (Assist) → intents locaux (fast) ou agent (conversation, streamée).

## Repères

- Spec complète : `docs/SPEC.md`
- Décisions : `docs/adr/` (ADR-002, 003, 006, 007 encore ouverts)
- Paramètres de régulation : `config/regulation.yaml` (seul fichier éditable par l'agent en prod)
