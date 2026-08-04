# Fixtures Tempo

> **Origine : dérivées de la documentation des deux APIs (portail
> data.rte-france.com et api-couleur-tempo.fr), pas d'un appel réel.** À recaler
> au premier `stellar-tempo verify` (checklist `docs/TESTING.md` §3 étape 4) :
> comparer `verify-<date>.json` à ces fichiers, corriger ici tout écart de forme,
> relancer les tests.

| Fichier                         | Contenu                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `rte/token.json`                | `POST /token/oauth/` — OAuth2 client credentials                                |
| `rte/tempo_like_calendars.json` | `GET /open_api/tempo_like_supply_contract/v1/tempo_like_calendars?start_date&…` |
| `opendata/jour-tempo.json`      | `GET /api/jourTempo/<yyyy-mm-dd>` (api-couleur-tempo.fr, fallback sans compte)  |

`@stellar/sim-tempo` charge ces trois fichiers comme **gabarits** de réponse :
il en reprend la forme et n'y substitue que les dates, les couleurs et le jeton.
Recaler les fixtures recale donc le simulateur, donc les tests du driver.

## Conventions à vérifier le jour J

1. **Bornes du jour Tempo.** Un jour Tempo court de 06 h à 06 h (heure de Paris).
   Les fixtures RTE portent donc `start_date` à `T06:00:00` avec l'offset local
   (`+01:00` l'hiver, `+02:00` l'été). Le driver ne découpe pas la chaîne : il
   prend la **date locale de Paris** de `start_date`, ce qui donne le bon jour
   que la période soit publiée à `T06:00:00`, à `T00:00:00` ou en UTC
   (`2026-08-03T04:00:00Z`). À confirmer sur la vraie réponse.
2. **Valeurs de couleur RTE** : `BLUE` / `WHITE` / `RED`. Toute autre valeur est
   loggée et ignorée (règle spec n°4).
3. **Codes du fallback** : `codeJour` 0 = inconnu, 1 = bleu, 2 = blanc, 3 = rouge.
4. **Publication du lendemain** vers 11 h : avant, la journée J+1 est soit absente
   de la réponse RTE, soit servie avec `codeJour: 0` par le fallback.

Les dumps `verify-<date>.json` produits par `stellar-tempo verify` atterrissent
dans le dossier parent (`__fixtures__/`) — ce sont des captures datées des deux
sources réelles. Elles ne contiennent **ni le client secret RTE ni l'access
token** (spec §14) : `verify` ne dumpe que les réponses métier.
