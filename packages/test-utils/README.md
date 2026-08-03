# @stellar/test-utils

Outils de test partagés, consommés **en source** (l'export `.` pointe sur
`src/index.ts` : pas de build, pas de `dist/`).

- `startTestBroker()` — broker MQTT aedes en mémoire sur un port libre (spec §15,
  ADR-010). aedes ne couvre MQTT 5 que partiellement : les bus de test se
  connectent en `protocolVersion: 4` et le req/resp passe par le fallback
  `home/ack/<commandId>`.

Les attentes se font avec `vi.waitFor` / `expect.poll` de vitest — pas de helper
`waitFor` maison.

## Configuration vitest

Chaque package testé a un `vitest.config.ts` qui étend `vitest.shared.ts`
(racine) via `mergeConfig`. La config partagée aliase `@stellar/contracts` et
`@stellar/bus` sur leurs **sources** : les tests n'ont pas besoin d'un
`pnpm build` préalable et `vitest --watch` réagit aux modifications des packages.

## Couverture

Il n'y a pas de rapport de couverture agrégé sur le workspace (fusionner des
rapports v8 entre packages coûte plus qu'il ne rapporte ici). La couverture se
lit **par package** :

```sh
pnpm --filter @stellar/core exec vitest run --coverage
```

Et en best-effort sur tout le workspace (`--no-bail` : un package sans test
n'interrompt pas la passe) :

```sh
pnpm coverage
```

`@vitest/coverage-v8` est une devDependency de la racine, résolue par remontée
depuis chaque package : rien à installer par package.
