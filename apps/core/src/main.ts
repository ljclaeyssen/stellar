#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { createMirror } from './mirror.js';

const logger = createLogger('core');
const mqttUrl = process.env.STELLAR_MQTT_URL ?? 'mqtt://localhost:1883';

/** Masque `user:pass@` dans une URL MQTT — les logs partent en clair vers journald. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***:***@');
}

const bus = await createBus({ url: mqttUrl, clientId: 'core', driver: 'core' });
const mirror = await createMirror({
  bus,
  logger,
  onChange: (entity) =>
    logger.info('state', { id: entity.id, kind: entity.kind, room: entity.room }),
});

logger.info('core démarré (miroir minimal)', { mqttUrl: redactUrl(mqttUrl) });

let shuttingDown = false;

function shutdown(signal: string): void {
  // SIGINT puis SIGTERM (ou double Ctrl-C) ne doivent pas relancer la fermeture.
  if (shuttingDown) return;
  shuttingDown = true;

  // Filet : si le broker ne répond plus, bus.close() peut ne jamais résoudre.
  // .unref() pour ne pas maintenir le process en vie si l'arrêt se passe bien.
  const forceExit = setTimeout(() => {
    logger.error('arrêt forcé — fermeture du bus trop lente', { signal });
    process.exit(1);
  }, 5_000);
  forceExit.unref();

  logger.info('arrêt', { signal, entities: mirror.getStates().length });
  void bus
    .close()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error('échec de la fermeture du bus', { signal, err: String(err) });
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
