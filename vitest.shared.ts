import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Base commune à tous les `vitest.config.ts` des packages (ADR-010).
 *
 * Les alias font pointer `@stellar/contracts` et `@stellar/bus` sur leurs **sources**
 * plutôt que sur `dist/` (ce que déclarent leurs `exports` package.json). Conséquences :
 * plus besoin de `pnpm build` avant `pnpm test`, et `vitest --watch` réagit à la
 * modification d'une source de package. Le build reste vérifié par `pnpm check`.
 */
const sourceOf = (pkg: string): string =>
  fileURLToPath(new URL(`packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    // Les suites d'intégration montent un broker aedes : 5 s (défaut) est trop court
    // sur une machine chargée ou en CI.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@stellar/contracts': sourceOf('contracts'),
      '@stellar/bus': sourceOf('bus'),
    },
  },
});
