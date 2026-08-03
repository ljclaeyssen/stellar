# Fixtures API Netatmo

> **Origine : dérivées de la documentation Netatmo (dev.netatmo.com), pas d'un
> compte réel.** À recaler sur le matériel au premier `stellar-netatmo verify`
> (checklist `docs/TESTING.md` §3 étape 4) : comparer `verify-<date>.json` à ces
> fichiers, corriger ici tout écart de forme, relancer les tests.

| Fichier                | Contenu                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `homesdata.json`       | `GET /api/homesdata` — 1 home « Maison », 1 room, 1 NAPlug + 1 NATherm1     |
| `homestatus.json`      | `GET /api/homestatus?home_id=…` — état de la room et des modules            |
| `getstationsdata.json` | `GET /api/getstationsdata` — 1 NAMain (« Salon ») + 1 NAModule1 (extérieur) |

`@stellar/sim-netatmo` charge ces trois fichiers comme état par défaut : recaler
les fixtures recale le simulateur, donc les tests du driver. Le simulateur
**réactualise les horodatages** (`time_utc`, `last_status_store`, `last_message`)
au chargement — sans quoi toute mesure servie serait périmée dès la première
seconde de test.

Les dumps `verify-<date>.json` produits par `stellar-netatmo verify` atterrissent
dans le dossier parent (`__fixtures__/`) — ce sont des captures datées du compte
réel, à conserver telles quelles. Elles contiennent des identifiants de matériel
(MAC des modules) mais **aucun token** : le dump n'enregistre jamais la réponse
`/oauth2/token`.
