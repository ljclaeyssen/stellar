import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRepoRoot, setupCommandPath } from './paths.js';
import { buildSystemPrompt } from './system-prompt.js';

/**
 * SOURCE UNIQUE — `.claude/commands/setup.md`.
 *
 * L'IHM ne recopie rien : elle lit le vrai fichier du dépôt à l'exécution. Ces
 * cas lisent eux aussi le vrai fichier (pas une fixture) — c'est le seul moyen de
 * garantir que les deux portes d'entrée, `claude` + `/setup` et cette IHM, disent
 * la même chose. Un doublon divergerait, et divergerait sur des instructions qui
 * manipulent des secrets.
 */

describe('prompt système de l’IHM de setup', () => {
  const repoRoot = resolveRepoRoot();
  const prompt = buildSystemPrompt(repoRoot);

  it('reprend intégralement la commande /setup du dépôt', () => {
    const procedure = readFileSync(setupCommandPath(repoRoot), 'utf8').trim();
    expect(prompt).toContain(procedure);
  });

  it('porte les règles absolues de la procédure', () => {
    // Phrases connues de `.claude/commands/setup.md` — si elles disparaissent,
    // c'est que ce test regarde le mauvais fichier.
    expect(prompt).toContain('Jamais un secret dans git');
    expect(prompt).toContain('Une étape = une vérification.');
    expect(prompt).toContain('config/regulation.yaml');
  });

  it('prévient l’assistant que ses outils passent par une approbation humaine', () => {
    expect(prompt).toContain('IHM web locale');
    expect(prompt).toMatch(/approbation de l['’]humain/);
    expect(prompt).toContain('Autoriser ou Refuser');
    // Le préambule précède la procédure : le canal se lit avant les étapes.
    expect(prompt.indexOf('IHM web locale')).toBeLessThan(prompt.indexOf('Une étape'));
  });
});
