#!/usr/bin/env node
import process from 'node:process';
import { startSimNetatmo } from './sim.js';

/**
 * Lancement à la main : `pnpm --filter @stellar/sim-netatmo start` (après build).
 * Variables : SIM_NETATMO_PORT (8843), SIM_NETATMO_CLIENT_ID,
 * SIM_NETATMO_CLIENT_SECRET, SIM_NETATMO_REFRESH_TOKEN, SIM_NETATMO_EXPIRES_IN.
 */
const DEFAULT_PORT = 8843;

const log = (entry: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ ...entry, ts: new Date().toISOString(), level: 'info', driver: 'sim-netatmo' })}\n`,
  );
};

const port = Number(process.env['SIM_NETATMO_PORT'] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write(`SIM_NETATMO_PORT invalide: ${String(process.env['SIM_NETATMO_PORT'])}\n`);
  process.exit(1);
}

const expiresInRaw = process.env['SIM_NETATMO_EXPIRES_IN'];
const sim = await startSimNetatmo({
  port,
  clientId: process.env['SIM_NETATMO_CLIENT_ID'],
  clientSecret: process.env['SIM_NETATMO_CLIENT_SECRET'],
  refreshToken: process.env['SIM_NETATMO_REFRESH_TOKEN'],
  ...(expiresInRaw === undefined ? {} : { expiresInSeconds: Number(expiresInRaw) }),
  log,
});

log({
  msg: 'sim-netatmo démarré',
  url: sim.url,
  clientId: sim.clientId,
  // Le refresh token initial est affiché à dessein : c'est un secret *de
  // simulateur*, et sans lui on ne peut pas amorcer un driver lancé à la main.
  hint: `echo '{"refreshToken":"${sim.state.refreshToken}"}' > config/netatmo-token.sim.json`,
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
