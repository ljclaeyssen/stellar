#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { loadConfig } from './config.js';
import { DRIVER_NAME, startFakeShutterDriver } from './driver.js';

/**
 * Process du driver : lit l'environnement, ouvre le bus, démarre le volet, gère
 * l'arrêt. Rien d'autre — comme tous les `main.ts` de `apps/drivers/*`.
 *
 * Variables : STELLAR_MQTT_URL, FAKESHUTTER_ENTITY_ID, FAKESHUTTER_ROOM,
 * FAKESHUTTER_SPEED_MS.
 */

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

async function run(): Promise<void> {
  const config = loadConfig();

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const shutter = await startFakeShutterDriver({
    bus,
    entityId: config.entityId,
    room: config.room,
    speedMs: config.speedMs,
    logger,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    // Filet : si le broker ne rend pas la main, on sort quand même.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    void (async () => {
      shutter.close();
      await bus.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Un bug non rattrapé ne doit pas laisser un process à moitié vivant : on sort
// en erreur, la supervision (systemd) relance.
process.on('unhandledRejection', (reason) => {
  logger.error('rejet non géré', { error: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('exception non gérée', { error: err.message });
  process.exit(1);
});

const command = process.argv[2] ?? 'run';
if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run)`);
  process.exit(1);
}
