#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { loadConfig, loadUnits, MISSING_UNITS_HELP, type MideaUnits } from './config.js';
import { DRIVER_NAME, startMideaDriver } from './driver.js';
import { verify } from './verify.js';

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Il n'y a **pas de commande `pair`** : les token/key s'obtiennent via le cloud
 * Midea avec `midea-discover`, en atelier, depuis le LAN de la maison (spec §9,
 * ADR-005). Le driver ne peut que dire clairement quoi faire.
 */
async function readUnits(file: string): Promise<MideaUnits> {
  try {
    return await loadUnits(file);
  } catch (err) {
    logger.error(MISSING_UNITS_HELP, {
      unitsFile: file,
      cause: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function run(): Promise<void> {
  const config = loadConfig();
  const units = await readUnits(config.unitsFile);

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const driver = await startMideaDriver({
    bus,
    units,
    logger,
    pollMs: config.pollMs,
    staleAfterMs: config.staleAfterMs,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    // Filet : si le broker ne rend pas la main, on sort quand même.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    void (async () => {
      driver.close();
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
if (command === 'verify') {
  const config = loadConfig();
  const units = await readUnits(config.unitsFile);
  try {
    const summary = await verify({ units, fixturesDir: config.fixturesDir, logger });
    // Une unité muette n'est pas une erreur d'outil : le résumé le dit, le code de
    // sortie aussi — c'est ce que l'humain lit le jour du branchement.
    process.exit(summary.reachable === summary.units.length ? 0 : 1);
  } catch (err) {
    logger.error('verify échoué', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | verify)`);
  process.exit(1);
}
