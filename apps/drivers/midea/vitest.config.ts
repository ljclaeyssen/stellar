import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../../vitest.shared.ts';

/**
 * Même intention que les alias de `vitest.shared.ts` (contracts, bus) : viser les
 * **sources** de `@stellar/midea-protocol` plutôt que son `dist/`, pour que
 * `pnpm test` n'exige pas un `pnpm build` préalable et que le watch réagisse aux
 * modifications du wrapper. L'alias est local au driver (le package est né avec
 * cette phase) ; le build reste vérifié par `pnpm check`.
 *
 * Le sous-chemin `/testing` est déclaré **en premier** : les alias chaîne de Vite
 * matchent par préfixe, l'ordre inverse le réécrirait en `…/index.ts/testing`.
 */
const protocolSrc = (file: string): string =>
  fileURLToPath(new URL(`../../../packages/midea-protocol/src/${file}`, import.meta.url));

export default mergeConfig(
  shared,
  defineConfig({
    test: { name: '@stellar/driver-midea' },
    resolve: {
      alias: {
        '@stellar/midea-protocol/testing': protocolSrc('testing.ts'),
        '@stellar/midea-protocol': protocolSrc('index.ts'),
      },
    },
  }),
);
