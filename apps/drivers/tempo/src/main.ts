#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { hasRteCredentials, loadConfig, type DriverConfig } from './config.js';
import { DRIVER_NAME, startTempoDriver } from './driver.js';
import { createOpendataSource } from './opendata.js';
import { createTempoReader } from './reader.js';
import { createRteSource } from './rte.js';
import type { TempoSourceLike } from './tempo.js';
import { verify } from './verify.js';

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Il n'y a **pas de commande `pair`** : la source primaire se configure sur le
 * portail data.rte-france.com (compte → application → souscription à « Tempo
 * Like Supply Contract » → client id/secret dans sops), et la source de repli ne
 * demande rien du tout. Sans identifiants, le driver fonctionne : il le dit et
 * s'en tient au fallback public.
 */
function buildSources(config: DriverConfig): {
  rte?: TempoSourceLike;
  fallback: TempoSourceLike;
} {
  const fallback = createOpendataSource({
    baseUrl: config.fallbackUrl,
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  if (!hasRteCredentials(config)) {
    logger.info(
      'aucun identifiant RTE (RTE_CLIENT_ID/RTE_CLIENT_SECRET) — source unique : l’API opendata publique. Voir TODO_LJ.md §P6 pour activer la source primaire.',
      { fallbackUrl: config.fallbackUrl },
    );
    return { fallback };
  }
  return {
    rte: createRteSource({
      baseUrl: config.rteApiUrl,
      clientId: config.rteClientId,
      clientSecret: config.rteClientSecret,
      logger,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    fallback,
  };
}

async function run(): Promise<void> {
  const config = loadConfig();
  const { rte, fallback } = buildSources(config);

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const reader = createTempoReader({
    ...(rte === undefined ? {} : { primary: rte }),
    fallback,
    logger,
  });
  const driver = await startTempoDriver({ bus, reader, logger, pollMs: config.pollMs });

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
  const { rte, fallback } = buildSources(config);
  try {
    await verify({
      ...(rte === undefined ? {} : { rte }),
      fallback,
      rteApiUrl: config.rteApiUrl,
      fallbackUrl: config.fallbackUrl,
      fixturesDir: config.fixturesDir,
      logger,
    });
  } catch (err) {
    logger.error('verify échoué', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  process.exit(0);
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | verify)`);
  process.exit(1);
}
