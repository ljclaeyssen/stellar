# Fixtures CLIP v2

> **Origine : dérivées de la documentation CLIP v2 (Philips Hue), pas d'un bridge
> réel.** À recaler sur le matériel au premier `stellar-hue verify` (checklist
> `docs/TESTING.md` §3 étape 4) : comparer `verify-<date>.json` à ces fichiers,
> corriger ici tout écart de forme, relancer les tests.

| Fichier                   | Contenu                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `lights.json`             | `GET /clip/v2/resource/light` — 2 lampes + 1 prise (`archetype: plug`) |
| `devices.json`            | `GET /clip/v2/resource/device` — les 3 devices propriétaires           |
| `rooms.json`              | `GET /clip/v2/resource/room` — salon (2 devices), chambre (1)          |
| `event-light-update.json` | un événement `update` du flux SSE `/eventstream/clip/v2`               |

`@stellar/sim-hue` charge `lights/devices/rooms` comme état par défaut : recaler
les fixtures recale le simulateur, donc les tests du driver.

Les dumps `verify-<date>.json` produits par `stellar-hue verify` atterrissent dans
le dossier parent (`__fixtures__/`) — ce sont des captures datées du bridge réel,
à conserver telles quelles.
