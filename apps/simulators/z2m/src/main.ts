#!/usr/bin/env node
import process from 'node:process';
import { DEFAULT_DEVICES, DEFAULT_FIXTURES_DIR } from './defaults.js';
import { startSimZ2m } from './sim.js';

/**
 * Lancement à la main : `pnpm --filter @stellar/sim-z2m start` (après build),
 * contre le mosquitto local d'`infra/docker-compose.yml`.
 *
 * Variables : SIM_Z2M_MQTT_URL (mqtt://localhost:1883), SIM_Z2M_BASE_TOPIC
 * (zigbee2mqtt), SIM_Z2M_FIXTURES_DIR, SIM_Z2M_PERIOD_MS (10000),
 * SIM_Z2M_AVAILABILITY_FORMAT (json | legacy).
 */
const DEFAULT_URL = 'mqtt://localhost:1883';

const log = (entry: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ ...entry, ts: new Date().toISOString(), level: 'info', driver: 'sim-z2m' })}\n`,
  );
};

const periodRaw = process.env['SIM_Z2M_PERIOD_MS'];
const periodMs = periodRaw === undefined ? undefined : Number(periodRaw);
if (periodMs !== undefined && (!Number.isFinite(periodMs) || periodMs <= 0)) {
  process.stderr.write(`SIM_Z2M_PERIOD_MS invalide: ${periodRaw}\n`);
  process.exit(1);
}

const formatRaw = process.env['SIM_Z2M_AVAILABILITY_FORMAT'] ?? 'json';
if (formatRaw !== 'json' && formatRaw !== 'legacy') {
  process.stderr.write(`SIM_Z2M_AVAILABILITY_FORMAT invalide: ${formatRaw} (json | legacy)\n`);
  process.exit(1);
}

const url = process.env['SIM_Z2M_MQTT_URL'] ?? DEFAULT_URL;
const sim = await startSimZ2m({
  url,
  baseTopic: process.env['SIM_Z2M_BASE_TOPIC'] ?? 'zigbee2mqtt',
  fixturesDir: process.env['SIM_Z2M_FIXTURES_DIR'] ?? DEFAULT_FIXTURES_DIR,
  devices: DEFAULT_DEVICES,
  ...(periodMs === undefined ? {} : { defaultPeriodMs: periodMs }),
  availabilityFormat: formatRaw,
  protocolVersion: 5,
  log,
});

// Un premier passage tout de suite : inutile d'attendre la première période
// pour voir le bus se remplir.
for (const name of sim.deviceNames) await sim.publishOnce(name);
sim.start();

log({ msg: 'sim-z2m démarré', url, baseTopic: sim.baseTopic, devices: sim.deviceNames });

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
