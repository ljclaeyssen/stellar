# Fixtures Zigbee2MQTT

> **Origine : payloads dérivés de la documentation Zigbee2MQTT (pages « supported
> devices »), pas de vrais capteurs.** Le parc Zigbee s'achète en P5 :
> **à recaler sur les vrais devices en P5 matériel**, au premier
> `stellar-z2m dump` (checklist `docs/TESTING.md` §3 étape 4) — comparer
> `dump-<date>.json` à ces fichiers, corriger ici tout écart de forme, relancer
> les tests.

| Fichier           | Modèle           | Contenu                                                     |
| ----------------- | ---------------- | ----------------------------------------------------------- |
| `snzb-02d.json`   | SONOFF SNZB-02D  | `zigbee2mqtt/<name>` d'un capteur T°/humidité sur pile      |
| `zy-m100.json`    | Tuya ZY-M100     | `zigbee2mqtt/<name>` d'un capteur de présence mmWave        |
| `zlinky-tic.json` | LiXee ZLinky_TIC | `zigbee2mqtt/zlinky` en **mode standard** du compteur Linky |

Points d'attention pour le recalage :

- **ZLinky** : les champs dépendent du mode TIC (historique vs standard) et du
  contrat. `apparent_power` est en **VA**, `current_summ_delivered` en **Wh**
  (index brut, non converti — la table `config/z2m-mapping.json` peut appliquer
  un `scale` si l'on veut des kWh). En mode historique les noms diffèrent
  (`current_summ_delivered` reste, `apparent_power` peut manquer).
- **SNZB-02D** : `battery`/`voltage`/`linkquality` ne sont pas mappés — le
  normalizer ne publie que ce que la table déclare.
- **ZY-M100** : `presence` est un booléen ; `target_distance` n'est pas mappé.
- Les payloads réels sont **partiels** : Z2M ne republie que les attributs
  reçus. C'est le cas nominal, pas une erreur.

`@stellar/sim-z2m` rejoue ces fichiers sur un broker : recaler les fixtures
recale le simulateur, donc les tests du driver.

Les dumps `dump-<date>.json` produits par `stellar-z2m dump` atterrissent dans ce
dossier — ce sont des captures datées du vrai Z2M, à conserver telles quelles.
