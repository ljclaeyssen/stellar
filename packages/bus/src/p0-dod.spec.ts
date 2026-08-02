import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Manifest,
  toJsonSchema,
  ClimateValue,
  type Ack,
  type Entity,
  type Health,
} from '@stellar/contracts';
import { createBus, type Bus } from './bus.js';
import { startTestBroker, type TestBroker } from './test-broker.js';

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
    await consumer.client.publishAsync(
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

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (seen.length > 0) resolve();
        else setTimeout(check, 20);
      };
      check();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('temp_salon');
  });

  it('aller-retour commande → ack via le fallback home/ack', async () => {
    await fakeDriver.onCommand((cmd): Ack => {
      expect(cmd.target).toBe('clim_salon');
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
    const received = new Promise<string>((resolve) => {
      void consumer.onEvent('fake/+', (event) => resolve(event.type));
    });
    // petite marge pour que la souscription soit effective (event non retained)
    await new Promise((r) => setTimeout(r, 100));
    await fakeDriver.publishEvent({
      driver: 'fake',
      type: 'button_pressed',
      data: { button: 'test' },
      ts: new Date().toISOString(),
    });
    expect(await received).toBe('button_pressed');
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

    const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    await waitFor(() => statuses.includes('online'));
    // Déconnexion brutale → le broker doit publier le will 'offline' retained.
    mortal.client.stream.destroy();
    await waitFor(() => statuses.includes('offline'));

    expect(statuses[0]).toBe('online');
    expect(statuses).toContain('offline');

    mortal.client.end(true);
    await watcher.close();
    await broker.close();
  });
});
