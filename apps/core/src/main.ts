#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { createCore } from './core.js';

const logger = createLogger('core');
const mqttUrl = process.env.STELLAR_MQTT_URL ?? 'mqtt://localhost:1883';
const dbPath = process.env.CORE_DB_PATH ?? 'data/journal.db';
const apiPort = Number(process.env.CORE_API_PORT ?? 8850);

if (!Number.isInteger(apiPort) || apiPort < 0 || apiPort > 65_535) {
  logger.error('CORE_API_PORT invalide', { value: process.env.CORE_API_PORT });
  process.exit(1);
}

/** Masque `user:pass@` dans une URL MQTT — les logs partent en clair vers journald. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***:***@');
}

const bus = await createBus({ url: mqttUrl, clientId: 'core', driver: 'core' });
const core = await createCore({ bus, logger, journalPath: dbPath, apiPort });

logger.info('core démarré', {
  mqttUrl: redactUrl(mqttUrl),
  dbPath,
  apiPort: core.api?.port,
  journalRows: core.journal.count(),
});

let shuttingDown = false;

function shutdown(signal: string): void {
  // SIGINT puis SIGTERM (ou double Ctrl-C) ne doivent pas relancer la fermeture.
  if (shuttingDown) return;
  shuttingDown = true;

  // Filet : si le broker ne répond plus, bus.close() peut ne jamais résoudre.
  // .unref() pour ne pas maintenir le process en vie si l'arrêt se passe bien.
  const forceExit = setTimeout(() => {
    logger.error('arrêt forcé — fermeture trop lente', { signal });
    process.exit(1);
  }, 5_000);
  forceExit.unref();

  logger.info('arrêt', { signal, entities: core.mirror.getStates().length });
  // Bus d'abord (plus aucun message n'arrive), core ensuite (le journal se ferme
  // sur un flux tari).
  void bus
    .close()
    .then(() => core.close())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error("échec de l'arrêt", { signal, err: String(err) });
      process.exit(1);
    });
}

// systemd et `docker stop` envoient SIGTERM ; le terminal SIGINT.
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Un core à moitié mort est pire qu'un core absent : on sort, systemd/docker relance
// (spec §14, restart=always).
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err.message, stack: err.stack });
  process.exit(1);
});
