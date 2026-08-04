#!/usr/bin/env node
import process from 'node:process';
import { startSimTempo } from './sim.js';
import type { SimCouleur } from './state.js';

/**
 * Lancement à la main : `pnpm --filter @stellar/sim-tempo start` (après build).
 * Variables : SIM_TEMPO_PORT (8844), SIM_TEMPO_CLIENT_ID, SIM_TEMPO_CLIENT_SECRET,
 * SIM_TEMPO_TODAY / SIM_TEMPO_TOMORROW (bleu | blanc | rouge).
 *
 * Le driver se branche dessus avec **les deux** URLs sur ce même port :
 * `RTE_API_URL=http://127.0.0.1:8844 TEMPO_FALLBACK_URL=http://127.0.0.1:8844`.
 */
const DEFAULT_PORT = 8844;

const log = (entry: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ ...entry, ts: new Date().toISOString(), level: 'info', driver: 'sim-tempo' })}\n`,
  );
};

const port = Number(process.env['SIM_TEMPO_PORT'] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write(`SIM_TEMPO_PORT invalide: ${String(process.env['SIM_TEMPO_PORT'])}\n`);
  process.exit(1);
}

const couleur = (raw: string | undefined, label: string): SimCouleur | undefined => {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'bleu' || raw === 'blanc' || raw === 'rouge') return raw;
  process.stderr.write(`${label} invalide: ${raw} (attendu: bleu | blanc | rouge)\n`);
  process.exit(1);
};

const today = couleur(process.env['SIM_TEMPO_TODAY'], 'SIM_TEMPO_TODAY');
const tomorrow = couleur(process.env['SIM_TEMPO_TOMORROW'], 'SIM_TEMPO_TOMORROW');

const sim = await startSimTempo({
  port,
  clientId: process.env['SIM_TEMPO_CLIENT_ID'],
  clientSecret: process.env['SIM_TEMPO_CLIENT_SECRET'],
  ...(today === undefined ? {} : { today }),
  ...(tomorrow === undefined ? {} : { tomorrow }),
  log,
});

log({
  msg: 'sim-tempo démarré',
  url: sim.url,
  // Identifiants *de simulateur* : affichés à dessein, sans eux on ne peut pas
  // amorcer un driver lancé à la main sur la source primaire.
  clientId: sim.clientId,
  clientSecret: sim.clientSecret,
  colors: sim.state.colors,
  hint: `RTE_API_URL=${sim.url} TEMPO_FALLBACK_URL=${sim.url} node apps/drivers/tempo/dist/main.js`,
});

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log({ msg: 'arrêt demandé', signal });
  setTimeout(() => process.exit(1), 2_000).unref();
  void sim.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
