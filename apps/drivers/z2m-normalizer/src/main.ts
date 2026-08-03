#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { loadConfig } from './config.js';
import { DRIVER_NAME, startZ2mNormalizer } from './driver.js';
import { dump } from './dump.js';
import { loadMappingTable } from './mapping-table.js';

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

async function run(): Promise<void> {
  const config = loadConfig();

  // La table est le contrat du driver : illisible ou incohérente, on ne démarre pas.
  const index = await loadMappingTable(config.mappingFile).catch((err: unknown) => {
    logger.error('table de mapping inutilisable', {
      file: config.mappingFile,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const driver = await startZ2mNormalizer({
    bus,
    index,
    logger,
    baseTopic: config.baseTopic,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    // Filet : si le broker ne rend pas la main, on sort quand même.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    void (async () => {
      await driver.close();
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
if (command === 'dump') {
  const config = loadConfig();
  try {
    await dump({
      mqttUrl: config.mqttUrl,
      baseTopic: config.baseTopic,
      durationMs: config.dumpDurationMs,
      fixturesDir: config.fixturesDir,
      logger,
    });
  } catch (err) {
    logger.error('dump échoué', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  process.exit(0);
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | dump)`);
  process.exit(1);
}
