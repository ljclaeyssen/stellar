import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClimateValue,
  Manifest,
  toJsonSchema,
  type Ack,
  type Command,
  type Entity,
  type Health,
} from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { createBus, type Bus } from './bus.js';

/**
 * DoD P0 (spec §16) : « un fake-driver publie un state typé qu'un fake-consumer valide ».
 */
describe('P0 DoD — fake-driver → fake-consumer', () => {
  let broker: TestBroker;
  let fakeDriver: Bus;
  let consumer: Bus;

  const climSalon: Entity = {
    id: 'clim_salon',
    driver: 'fake',
    kind: 'climate',
    room: 'salon',
    value: { power: true, mode: 'heat', targetTemp: 20.5, indoorTemp: 19.8, fan: 'auto' },
    ts: new Date().toISOString(),
  };

  const manifest: Manifest = {
    driver: 'fake',
    version: '0.1.0',
    entities: [{ id: 'clim_salon', kind: 'climate', room: 'salon' }],
    commands: [{ action: 'set', paramsSchema: toJsonSchema(ClimateValue.partial()) }],
  };

  beforeAll(async () => {
    broker = await startTestBroker();
    fakeDriver = await createBus({
      url: broker.url,
      clientId: 'fake-driver',
      driver: 'fake',
      protocolVersion: 4,
    });
    consumer = await createBus({
      url: broker.url,
      clientId: 'fake-consumer',
      driver: 'consumer',
      protocolVersion: 4,
    });
  });

  afterAll(async () => {
    await consumer.close();
    await fakeDriver.close();
    await broker.close();
  });

  it('publie un state typé, retained, validé côté consumer par sélecteur kind+room', async () => {
    await fakeDriver.announce(manifest);
    await fakeDriver.publishState(climSalon);

    // Le consumer s'abonne APRÈS la publication : le retained doit suffire.
    const received = await new Promise<Entity>((resolve) => {
      void consumer.onState({ kind: 'climate', room: 'salon' }, (entity) => resolve(entity));
    });

    expect(received.id).toBe('clim_salon');
    expect(received.driver).toBe('fake');
    expect((received.value as { targetTemp: number }).targetTemp).toBe(20.5);
  });

  it('jette silencieusement un state invalide (value incompatible avec le kind)', async () => {
    const seen: Entity[] = [];
    await consumer.onState({ kind: 'temperature' }, (entity) => seen.push(entity));

    // Publication brute (sans passer par publishState qui refuserait) : value string ≠ number.
    await fakeDriver.client.publishAsync(
      'home/state/fake/temp_bidon',
      JSON.stringify({
        id: 'temp_bidon',
        driver: 'fake',
        kind: 'temperature',
        value: 'dix-neuf',
        ts: new Date().toISOString(),
      }),
      { qos: 1, retain: false },
    );
    // Sentinelle valide publiée APRÈS : quand elle arrive, l'invalide est forcément
    // déjà passé dans le dispatch (ordre garanti par la connexion TCP).
    const valid: Entity = {
      id: 'temp_salon',
      driver: 'fake',
      kind: 'temperature',
      room: 'salon',
      value: 19.2,
      unit: '°C',
      ts: new Date().toISOString(),
    };
    await fakeDriver.publishState(valid);

    await vi.waitFor(() => expect(seen.map((e) => e.id)).toContain('temp_salon'));
    expect(seen).toHaveLength(1);
  });

  it('aller-retour commande → ack via le fallback home/ack', async () => {
    const handled: Command[] = [];
    await fakeDriver.onCommand((cmd): Ack => {
      handled.push(cmd);
      return { commandId: cmd.id, status: 'ok' };
    });

    const ack = await consumer.sendCommand(
      {
        id: randomUUID(),
        target: 'clim_salon',
        action: 'set',
        params: { targetTemp: 21 },
        issuedBy: 'cli',
        ts: new Date().toISOString(),
      },
      { driver: 'fake', timeoutMs: 2_000 },
    );
    expect(ack.status).toBe('ok');
    expect(handled).toHaveLength(1);
    expect(handled[0]?.target).toBe('clim_salon');
  });

  it('renvoie un Ack timeout quand personne ne répond', async () => {
    const ack = await consumer.sendCommand(
      {
        id: randomUUID(),
        target: 'clim_fantome',
        action: 'set',
        params: {},
        issuedBy: 'cli',
        ts: new Date().toISOString(),
      },
      { driver: 'ghost', timeoutMs: 300 },
    );
    expect(ack.status).toBe('timeout');
  });

  it('transmet un événement ponctuel', async () => {
    const types: string[] = [];
    await consumer.onEvent('fake/+', (event) => types.push(event.type));
    await fakeDriver.publishEvent({
      driver: 'fake',
      type: 'button_pressed',
      data: { button: 'test' },
      ts: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(types).toContain('button_pressed'));
  });
});

describe('health / LWT', () => {
  it('publie online à la connexion et offline (LWT) sur déconnexion brutale', async () => {
    const broker = await startTestBroker();
    const watcher = await createBus({
      url: broker.url,
      clientId: 'watcher',
      driver: 'watcher',
      protocolVersion: 4,
    });

    const statuses: Health['status'][] = [];
    await watcher.client.subscribeAsync('home/health/mortal', { qos: 1 });
    watcher.client.on('message', (topic, payload) => {
      if (topic === 'home/health/mortal') {
        statuses.push((JSON.parse(payload.toString()) as Health).status);
      }
    });

    const mortal = await createBus({
      url: broker.url,
      clientId: 'mortal',
      driver: 'mortal',
      protocolVersion: 4,
      reconnectMinMs: 60_000, // pas de reconnexion pendant le test
    });

    await vi.waitFor(() => expect(statuses).toContain('online'));
    // Déconnexion brutale → le broker doit publier le will 'offline' retained.
    mortal.client.stream.destroy();
    await vi.waitFor(() => expect(statuses).toContain('offline'));

    expect(statuses[0]).toBe('online');

    mortal.client.end(true);
    await watcher.close();
    await broker.close();
  });
});
