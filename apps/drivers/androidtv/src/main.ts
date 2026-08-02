#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createAndroidRemote, type Certificate } from '@kud/androidtv-remote';
import { createBus, createLogger } from '@stellar/bus';
import { loadConfig } from './config.js';
import { DRIVER_NAME, startAndroidTvDriver } from './driver.js';
import { pair } from './pair.js';

const logger = createLogger(DRIVER_NAME);

async function run(): Promise<void> {
  const config = loadConfig();

  let cert: Certificate;
  try {
    cert = JSON.parse(await readFile(config.certFile, 'utf8')) as Certificate;
  } catch {
    logger.error(
      `certificat introuvable (${config.certFile}) — lancer d'abord: stellar-androidtv pair`,
    );
    process.exit(1);
  }

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const remote = createAndroidRemote(config.tvHost, { cert, service_name: 'stellar' });
  await startAndroidTvDriver({
    bus,
    remote,
    entityId: config.entityId,
    room: config.room,
    logger,
  });

  // Reconnexion backoff expo (règle commune drivers) : la lib ne reconnecte pas
  // seule — on redémarre la session sur erreur, sans crash-loop silencieux.
  let retries = 0;
  const restart = (): void => {
    const delay = Math.min(60_000, 5_000 * 2 ** retries);
    retries += 1;
    logger.warn('session TV perdue, reconnexion', { delayMs: delay, attempt: retries });
    setTimeout(() => {
      void remote
        .start()
        .then(() => {
          retries = 0;
        })
        .catch(() => restart());
    }, delay);
  };
  remote.on('error', () => restart());
  remote.on('unpaired', () => {
    logger.error('certificat révoqué par la TV — relancer le pairing');
    process.exit(1);
  });

  const shutdown = (): void => {
    void (async () => {
      remote.stop();
      await bus.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await remote.start();
  logger.info('connecté à la TV', { host: config.tvHost });
}

const command = process.argv[2] ?? 'run';
if (command === 'pair') {
  const config = loadConfig();
  await pair(config.tvHost, config.certFile, logger);
  process.exit(0);
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | pair)`);
  process.exit(1);
}
