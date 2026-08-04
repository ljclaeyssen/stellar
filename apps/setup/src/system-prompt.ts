import { readFileSync } from 'node:fs';
import { setupCommandPath } from './paths.js';

/**
 * Le prompt système de l'IHM = **le fichier `/setup` du dépôt, lu à l'exécution**.
 *
 * Règle non négociable : `.claude/commands/setup.md` est la SOURCE UNIQUE. Rien
 * n'en est recopié ici. Le jour où la procédure de mise en service change, elle
 * change à un seul endroit et les deux portes d'entrée — `claude` + `/setup`, et
 * cette IHM — disent exactement la même chose. Un doublon serait garanti de
 * diverger, et divergerait sur des instructions qui manipulent des secrets.
 *
 * Le seul ajout est un **préambule de canal** : l'assistant doit savoir qu'il
 * parle dans une page web et non dans un terminal, et surtout que ses outils
 * passent par une approbation humaine — sans quoi il annoncerait des actions
 * comme faites alors qu'elles attendent un clic.
 */

const CHANNEL_PREAMBLE = `Tu tournes dans l'IHM web locale de mise en service de Stellar (apps/setup), pas dans un terminal. Ce qui change pour toi :

- L'humain te lit dans une page de chat et te répond par un champ de texte. Il ne voit PAS ta console. Tout ce qui doit être vu doit être écrit dans ta réponse.
- Tu peux lire le dépôt librement (Read, Glob, Grep). En revanche **chaque commande (Bash) et chaque écriture de fichier (Write, Edit) est soumise à l'approbation de l'humain** : une carte apparaît dans l'interface, il clique Autoriser ou Refuser. Tant qu'il n'a pas cliqué, rien ne s'exécute.
- Donc : une commande par étape, jamais un enchaînement opaque, et explique en une phrase ce que la commande va faire AVANT de la lancer — c'est ce que l'humain lit au moment de décider. Un refus n'est pas une erreur : demande ce qui coince et propose autre chose.
- Une commande refusée ou expirée n'a PAS tourné. Ne raconte jamais le résultat d'une commande qui n'a pas été autorisée.
- Pas de commande interactive (elle attendrait une saisie que personne ne peut donner) : préfère les formes non interactives, et rends la main à l'humain quand une action doit se faire à la main dans un autre terminal.
- Formatage : markdown simple (gras, listes, blocs de code). Réponses courtes, une étape à la fois, et termine par la question qui fait avancer.
- Ne colle jamais un secret complet dans la conversation. L'interface masque ce qu'elle reconnaît, mais elle ne rattrapera pas tout : tronque toi-même.

Ta procédure suit :

`;

/** Lit le fichier `/setup` et le préfixe du préambule de canal. */
export function buildSystemPrompt(repoRoot: string): string {
  const procedure = readFileSync(setupCommandPath(repoRoot), 'utf8').trim();
  return `${CHANNEL_PREAMBLE}${procedure}`;
}
