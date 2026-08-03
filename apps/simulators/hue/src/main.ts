#!/usr/bin/env node
import process from 'node:process';
import { startSimHue } from './sim.js';

/**
 * Lancement à la main : `pnpm --filter @stellar/sim-hue start` (après build).
 * Variables : SIM_HUE_PORT (8842), SIM_HUE_APP_KEY, SIM_HUE_LINK_BUTTON=1.
 */
const DEFAULT_PORT = 8842;

const log = (entry: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ ...entry, ts: new Date().toISOString(), level: 'info', driver: 'sim-hue' })}\n`,
  );
};

const port = Number(process.env['SIM_HUE_PORT'] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write(`SIM_HUE_PORT invalide: ${String(process.env['SIM_HUE_PORT'])}\n`);
  process.exit(1);
}

const sim = await startSimHue({
  port,
  applicationKey: process.env['SIM_HUE_APP_KEY'],
  linkButtonPressed: process.env['SIM_HUE_LINK_BUTTON'] === '1',
  log,
});

log({
  msg: 'sim-hue démarré',
  url: sim.url,
  applicationKey: sim.applicationKey,
  lights: sim.state.lights.length,
  rooms: sim.state.rooms.length,
  hint: 'SIM_HUE_LINK_BUTTON=1 pour simuler le bouton du bridge déjà pressé',
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
