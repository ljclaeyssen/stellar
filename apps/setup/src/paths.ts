import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repères de fichiers de l'IHM de setup.
 *
 * Deux chemins, deux natures :
 * - la **racine du dépôt** est le `cwd` de la session — l'assistant y installe, y
 *   remplit `.env`, y appaire du matériel. Elle se déduit de l'emplacement de ce
 *   module (`apps/setup/{src,dist}/paths.js` → trois niveaux au-dessus) ;
 * - `ui.html` est **à côté** de ce module : `src/` quand on tourne les sources
 *   (tests, `tsx`), `dist/` en build (le html y est recopié). Aucune des deux
 *   variantes n'a besoin d'être connue de l'appelant.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Le fichier qui prouve qu'on est bien à la racine du dépôt (et pas ailleurs). */
export const SETUP_COMMAND_RELATIVE = join('.claude', 'commands', 'setup.md');

export class RepoRootNotFoundError extends Error {
  constructor(readonly attempted: string) {
    super(
      `racine du dépôt introuvable depuis ${moduleDir} : ${join(attempted, SETUP_COMMAND_RELATIVE)} n’existe pas. ` +
        'Lance l’IHM depuis un clone complet de stellar (pnpm setup:ui).',
    );
    this.name = 'RepoRootNotFoundError';
  }
}

/**
 * Remonte de `apps/setup/<src|dist>` vers la racine, puis **vérifie** : sans le
 * fichier de commande, le prompt système n'existe pas et l'IHM n'a rien à dire.
 * Mieux vaut échouer ici, avec un chemin dans le message, qu'au premier tour.
 */
export function resolveRepoRoot(): string {
  const root = resolve(moduleDir, '..', '..', '..');
  if (!existsSync(join(root, SETUP_COMMAND_RELATIVE))) throw new RepoRootNotFoundError(root);
  return root;
}

/** Chemin du fichier `/setup` — SOURCE UNIQUE, lue à l'exécution, jamais copiée. */
export const setupCommandPath = (repoRoot: string): string =>
  join(repoRoot, SETUP_COMMAND_RELATIVE);

/** Chemin de la page servie par `GET /` — `src/` en dev, `dist/` après build. */
export const uiHtmlPath = (): string => join(moduleDir, 'ui.html');
