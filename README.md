# Stellar

Domotique maison 100 % locale, pilotée par agent — bus MQTT, drivers
traducteurs, régulation déterministe, agent LLM en périphérie (jamais dans la
boucle temps réel). Architecture et contrats : [docs/SPEC.md](docs/SPEC.md) ·
décisions : [docs/adr/](docs/adr) · stratégie de test sans matériel :
[docs/TESTING.md](docs/TESTING.md).

## Je clone, je fais quoi ?

```bash
pnpm install
pnpm check                                        # build + lint + 423 tests
docker compose -f infra/docker-compose.yml up -d  # mosquitto
pnpm bench                                        # la maison SIMULÉE complète
node apps/cli/dist/main.js states --follow        # observer le bus
```

## Premier setup sur une vraie machine (dev ou N100)

Avec [Claude Code](https://claude.com/claude-code) :

```bash
claude
```

puis tape `/setup` — l'assistant vérifie les prérequis, remplit `.env` avec
toi (modèle : [.env.example](.env.example)), initialise sops/age, et déroule
les branchements matériels (TV, Hue, Netatmo, Midea, Zigbee) selon les
checklists de [TODO_LJ.md](TODO_LJ.md).

Sans installer Claude Code, `ANTHROPIC_API_KEY=… pnpm setup:ui` sert le même
assistant (même fichier `/setup`) dans une page locale sur
http://127.0.0.1:8853, où chaque commande et chaque écriture de fichier
demandent ton accord avant de s'exécuter. Sans clé du tout : suivre TODO_LJ.md
à la main, tout y est.

## Layout

| Où                   | Quoi                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `packages/contracts` | contrats zod du bus (Entity, Command, kinds…)                               |
| `packages/bus`       | client MQTT typé (LWT, req/resp, retained)                                  |
| `apps/core`          | miroir, journal SQLite, régulation, API tRPC, MCP, pont HA                  |
| `apps/drivers/*`     | traducteurs purs (androidtv, hue, netatmo, midea, tempo, z2m, fake-shutter) |
| `apps/simulators/*`  | simulateurs de périphériques (dev sans matériel)                            |
| `apps/agent`         | agent Claude (sessions éphémères, propositions à confirmation)              |
| `infra/`             | compose mosquitto + voix, units systemd, config HA de plomberie             |
| `config/`            | regulation.yaml, mapping Zigbee, secrets chiffrés sops (`*.enc.*`)          |

Secrets : jamais en clair dans git — `.gitignore` en allowlist sur `config/`,
chiffrement sops/age, variables d'environnement par service.
