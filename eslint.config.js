import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Noms de drivers interdits en littéral dans core/agent (spec règle n°7, ADR-008). */
const DRIVER_NAMES = /^(hue|netatmo|midea|tempo|androidtv|z2m|z2m-normalizer)$/;
const DRIVER_NAME_MESSAGE =
  'Nom de driver en dur interdit dans core/agent (spec règle n°7) : passer par un sélecteur kind+room, et par entity.driver du miroir pour le transport (docs/adr/ADR-008-sendcommand-driver.md).';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    name: 'stellar/type-aware',
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          /**
           * Les `*.spec.ts` sont volontairement hors des tsconfig de build (ils ne
           * doivent pas être émis dans `dist/`) : le project service ne les trouve
           * donc dans aucun projet. On les rattache au projet par défaut plutôt que
           * de renoncer au type-aware dessus (no-floating-promises sur un test vaut
           * cher) — `tsconfig.lint.json` lui donne bien NodeNext + strict, sans quoi
           * les imports `@stellar/*` seraient des `any`.
           *
           * Globs relatifs à `tsconfigRootDir`, `**` interdit, et le nombre de
           * fichiers concernés est plafonné (8 par défaut). Si ce plafond saute, la
           * vraie correction est de scinder chaque package en tsconfig.json (lint,
           * tout `src`) + tsconfig.build.json (émission).
           *
           * Le plafond a sauté en P2 : `apps/drivers/hue` applique la scission et
           * revendique donc ses propres specs — il ne doit PAS figurer ici (un
           * fichier à la fois dans un projet et dans allowDefaultProject est une
           * erreur de parsing). D'où les globs nommément limités : chaque nouveau
           * package fait la scission et sort de cette liste.
           *
           * P4 : `packages/midea-protocol` et `apps/drivers/midea` scindent eux
           * aussi, d'où le glob `packages/*` remplacé par la liste des deux seuls
           * packages qui dépendent encore du projet par défaut.
           */
          allowDefaultProject: [
            'packages/bus/src/*.spec.ts',
            'packages/contracts/src/*.spec.ts',
            'apps/*/src/*.spec.ts',
            'apps/drivers/androidtv/src/*.spec.ts',
          ],
          defaultProject: 'tsconfig.lint.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Fichiers hors programme TypeScript : la config eslint elle-même (JS) et les
    // configs vitest (chargées par esbuild, absentes des tsconfig de build).
    name: 'stellar/no-type-aware',
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', 'vitest.shared.ts', '**/vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Frontière assumée avec la lib zod-to-json-schema, dont les types sont lâches
    // (ZodTypeAny / retour non typé) : le cast y est le contrat, pas une dette.
    name: 'stellar/contracts-json-schema-boundary',
    files: ['packages/contracts/src/json-schema.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Mécanisation de l'interdit n°7 : aucun nom de driver ne doit apparaître dans
    // la logique du core ni de l'agent. Les specs sont exclues : elles montent des
    // scénarios de bout en bout et parlent légitimement de transport.
    name: 'stellar/no-driver-names',
    files: ['apps/core/**/*.ts', 'apps/agent/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${DRIVER_NAMES.toString()}]`, message: DRIVER_NAME_MESSAGE },
        {
          selector: `TemplateElement[value.cooked=${DRIVER_NAMES.toString()}]`,
          message: DRIVER_NAME_MESSAGE,
        },
      ],
    },
  },
);
