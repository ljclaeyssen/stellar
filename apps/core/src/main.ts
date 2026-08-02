#!/usr/bin/env node
import process from 'node:process';
import { createBus, createLogger } from '@stellar/bus';
import { createMirror } from './mirror.js';

const logger = createLogger('core');
const mqttUrl = process.env.STELLAR_MQTT_URL ?? 'mqtt://localhost:1883';

const bus = await createBus({ url: mqttUrl, clientId: 'core', driver: 'core' });
const mirror = await createMirror({
  bus,
  logger,
  onChange: (entity) =>
    logger.info('state', { id: entity.id, kind: entity.kind, room: entity.room }),
});

logger.info('core démarré (miroir minimal)', { mqttUrl });

process.on('SIGINT', () => {
  logger.info('arrêt', { entities: mirror.getStates().length });
  void bus.close().then(() => process.exit(0));
});
