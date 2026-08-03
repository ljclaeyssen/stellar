import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalizeStatus, type MideaStatus } from './status.js';

/**
 * Fixtures de statuts (`__fixtures__/`, règle spec §17).
 *
 * ⚠️ Elles sont **dérivées de la documentation** de node-mideahvac (tables du
 * README), pas d'un échange avec le matériel : les tokens n'existent pas encore
 * (atelier P4.0, TODO_LJ.md). Elles sont donc à **recaler au premier
 * `stellar-midea verify`** — c'est exactement l'étape 4 de la checklist de
 * branchement matériel (docs/TESTING.md §3).
 */
export const FIXTURE_NAMES = ['status-heat', 'status-cool', 'status-off'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

const FixtureFile = z.object({ _note: z.string(), status: z.record(z.unknown()) }).passthrough();

/**
 * `__fixtures__` est à la racine du package : le même `../__fixtures__` marche
 * depuis `src/` (vitest, qui alias les sources) comme depuis `dist/` (build).
 */
const fixtureUrl = (name: FixtureName): URL =>
  new URL(`../__fixtures__/${name}.json`, import.meta.url);

const cache = new Map<FixtureName, MideaStatus>();

/** Statut normalisé issu d'une fixture. Lecture synchrone : un fichier, une fois. */
export function loadStatusFixture(name: FixtureName = 'status-heat'): MideaStatus {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(fixtureUrl(name)), 'utf8'));
  const status = normalizeStatus(FixtureFile.parse(raw).status);
  cache.set(name, status);
  return status;
}
