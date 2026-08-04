// `src/ui.html` n'est pas compilé : il est servi tel quel. `tsc` ignore les
// fichiers non-TS, donc le build le recopie ici — c'est tout ce que fait ce
// script, et c'est la seule raison pour laquelle il existe.
import { copyFileSync, mkdirSync } from 'node:fs';
// Imports explicites plutôt que globals : ce fichier est du Node ESM pur, hors de
// tout programme TypeScript, et eslint n'y suppose aucun environnement
// (même convention que scripts/bench.mjs).
import { fileURLToPath, URL } from 'node:url';

const from = fileURLToPath(new URL('../src/ui.html', import.meta.url));
const toDir = fileURLToPath(new URL('../dist/', import.meta.url));

mkdirSync(toDir, { recursive: true });
copyFileSync(from, `${toDir}ui.html`);
