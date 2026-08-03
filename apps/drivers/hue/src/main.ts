#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { createHueApi } from './api.js';
import { AppKeyFile, loadConfig, type DriverConfig } from './config.js';
import { DRIVER_NAME, startHueDriver } from './driver.js';
import { pair } from './pair.js';
import { verify } from './verify.js';

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * L'application key vient soit de l'environnement (injectée depuis sops), soit
 * du fichier produit par `stellar-hue pair`. Un fichier tronqué ferait échouer
 * chaque requête en 403 sans dire pourquoi : on préfère un message net.
 */
async function resolveApplicationKey(config: DriverConfig): Promise<string> {
  if (config.appKey !== undefined) return config.appKey;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(config.appKeyFile, 'utf8')) as unknown;
  } catch {
    logger.error(
      `application key introuvable — renseigner HUE_APP_KEY ou lancer: stellar-hue pair (fichier attendu: ${config.appKeyFile})`,
    );
    process.exit(1);
  }
  const parsed = AppKeyFile.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      `application key invalide/corrompue (${config.appKeyFile}) — relancer le pairing: stellar-hue pair`,
    );
    process.exit(1);
  }
  return parsed.data.applicationKey;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const applicationKey = await resolveApplicationKey(config);

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  // La supervision du lien bridge vit dans la couture (`openEventStream` :
  // backoff expo 1 s → 30 s, onDown/onUp) — pas de boucle de reconnexion ici.
  const api = createHueApi({ baseUrl: config.bridgeUrl, applicationKey, logger });
  const driver = await startHueDriver({ bus, api, logger });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    // Filet : si le broker ou la socket SSE ne rendent pas la main, on sort quand même.
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
if (command === 'pair') {
  const config = loadConfig();
  try {
    await pair(config.bridgeUrl, config.appKeyFile, logger);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
} else if (command === 'verify') {
  const config = loadConfig();
  const applicationKey = await resolveApplicationKey(config);
  const api = createHueApi({ baseUrl: config.bridgeUrl, applicationKey, logger });
  try {
    await verify({ api, bridgeUrl: config.bridgeUrl, fixturesDir: config.fixturesDir, logger });
  } catch (err) {
    logger.error('verify échoué', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  process.exit(0);
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | pair | verify)`);
  process.exit(1);
}
