# `stellar_conversation` — le chemin lent de la voix

Composant Home Assistant **de plomberie pure** (P8, spec §12). Il déclare une
entité de conversation qui relaie chaque tour à `apps/agent` en HTTP et rend sa
réponse à Assist, qui la fait parler par Piper.

Il ne contient **aucune logique** : pas de règle, pas de mémoire, pas d'appel au
bus MQTT. C'est délibéré (interdit §4 n°5) — la décision vit dans `apps/core`,
l'intelligence dans `apps/agent`, HA n'est qu'un tuyau que l'on doit pouvoir
jeter (ADR-003).

## Les deux vitesses

| Chemin | Qui répond                                                                          | Latence           |
| ------ | ----------------------------------------------------------------------------------- | ----------------- |
| Rapide | Intents locaux d'Assist, sur les entités annoncées par le pont HA-discovery du core | < 1 s             |
| Lent   | Ce composant → `apps/agent` → API Anthropic                                         | quelques secondes |

Le chemin rapide ne passe pas par ici : une phrase qu'Assist reconnaît
(« allume la lumière du salon ») est exécutée localement, sans agent ni réseau.
Ce composant n'attrape que le reste.

## Installation

Pas de HACS (interdit §4 n°5), pas de dépôt tiers : **copie de fichiers**.

```sh
# depuis la racine du dépôt
cp -r infra/ha/custom_components/stellar_conversation \
      /chemin/vers/ha/config/custom_components/
```

Avec `infra/docker-compose.voice.yml`, la copie est inutile : le dossier
`infra/ha/custom_components` est déjà monté en lecture seule sur
`/config/custom_components`.

Puis, dans `configuration.yaml` (déjà présent dans `infra/ha/config/`) :

```yaml
stellar_conversation:
  url: http://127.0.0.1:8852/turn
  timeout: 45
```

Redémarrer HA, puis **Paramètres → Assistants vocaux → \<pipeline\> → Agent de
conversation → Stellar**.

## Contrat avec `apps/agent`

```
POST /turn   {"prompt": "…", "context": "…"}   ← corps strict, `context` optionnel
200          {"text": "…", "isError": false, "usage": {…}}
```

`context` ne porte que l'origine de la voix (identifiant du satellite). Tout le
reste — état de la maison, journal, Tempo — l'agent va le chercher lui-même par
le MCP du core : le composant n'a rien à lui apprendre.

## Limites assumées de ce gabarit

- **Pas de streaming.** La spec §12 veut que le TTS parle dès les premiers mots ;
  ici on attend la réponse complète. À reprendre quand `apps/agent` exposera un
  endpoint SSE — les deux moitiés arrivent ensemble.
- **Pas de continuité de conversation.** `conversation_id` est renvoyé tel quel,
  mais l'agent ouvre une session éphémère par tour (spec §11). Le multi-tours
  se branchera en passant `sessionId` dans les deux sens.
- **Testé à la relecture, pas à l'exécution.** C'est un gabarit de bring-up :
  la vérification se fait sur le N100 avec un vrai HA (P8 matériel).
- `documentation` / `issue_tracker` du `manifest.json` pointent sur l'URL
  attendue du dépôt privé — à ajuster si elle diffère.
