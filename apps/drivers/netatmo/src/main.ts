#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { createNetatmoApi } from './api.js';
import { createTokenStore, type TokenStore } from './auth.js';
import { loadConfig, type DriverConfig } from './config.js';
import { DRIVER_NAME, startNetatmoDriver } from './driver.js';
import { verify } from './verify.js';

const logger = createLogger(DRIVER_NAME);

/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Il n'y a **pas de commande `pair`** : la création de l'app OAuth et l'obtention
 * du premier refresh token passent par le portail dev.netatmo.com (Token
 * generator), pas par une API. Le driver ne peut que dire clairement quoi faire.
 */
function explainMissingToken(config: DriverConfig, cause: string): never {
  logger.error(
    `refresh token Netatmo introuvable ou illisible (${config.tokenFile}) — procédure : dev.netatmo.com → My apps → Token generator (scopes read_thermostat write_thermostat read_station), puis écrire {"refreshToken":"<le-token>"} dans ce fichier. Détail dans TODO_LJ.md §P3.`,
    { cause },
  );
  process.exit(1);
}

async function createTokens(config: DriverConfig): Promise<TokenStore> {
  const tokens = createTokenStore({
    apiUrl: config.apiUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenFile: config.tokenFile,
    authRetryMs: config.authRetryMs,
    logger,
    onAuthDead: (reason) => logger.error('authentification Netatmo perdue', { cause: reason }),
    onAuthRecovered: () => logger.info('authentification Netatmo de nouveau valide'),
  });
  try {
    // Échouer tôt et clairement plutôt qu'en boucle au premier polling.
    await tokens.load();
  } catch (err) {
    explainMissingToken(config, err instanceof Error ? err.message : String(err));
  }
  return tokens;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const tokens = await createTokens(config);

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const api = createNetatmoApi({ baseUrl: config.apiUrl, tokens, logger });
  const driver = await startNetatmoDriver({
    bus,
    api,
    logger,
    thermostatIntervalMs: config.thermostatIntervalMs,
    stationIntervalMs: config.stationIntervalMs,
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
  const tokens = await createTokens(config);
  const api = createNetatmoApi({ baseUrl: config.apiUrl, tokens, logger });
  try {
    await verify({ api, apiUrl: config.apiUrl, fixturesDir: config.fixturesDir, logger });
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
