import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, type Ack, type CoverValue, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { loadConfig } from './config.js';
import { startFakeShutterDriver, type FakeShutterHandle } from './driver.js';

/** Pas de bruit dans la sortie de test — le driver logue sur stdout en prod. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cmd = (params: Record<string, unknown>, target = 'volet_salon', action = 'set') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('fake-shutter-driver', () => {
  // Tout est recréé à chaque test, broker compris : sinon les messages *retained*
  // (state, discovery) d'un test fuiraient dans le suivant.
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;
  let shutter: FakeShutterHandle;
  let states: Entity[];

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'fake-shutter', timeoutMs: 2_000 });

  const lastCover = (): CoverValue => {
    const last = states.at(-1);
    if (last === undefined) throw new Error('aucun state publié');
    if (!isKind(last, 'cover')) throw new Error(`state publié non-cover: ${last.kind}`);
    return last.value;
  };

  beforeEach(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: `fake-shutter-driver-${randomUUID()}`,
      driver: 'fake-shutter',
      protocolVersion: 4,
      logger: silentLogger,
    });
    consumer = await createBus({
      url: broker.url,
      clientId: `test-consumer-${randomUUID()}`,
      driver: 'consumer',
      protocolVersion: 4,
      logger: silentLogger,
    });
    states = [];
    await consumer.onState({ kind: 'cover', room: 'salon' }, (entity) => states.push(entity));
    shutter = await startFakeShutterDriver({
      bus: driverBus,
      entityId: 'volet_salon',
      room: 'salon',
      // Course complète en 100 ms : le test observe le mouvement sans l'attendre.
      speedMs: 5,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    shutter.close();
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('annonce un manifeste discovery retained valide', async () => {
    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/fake-shutter' && payload.length > 0) {
          resolve(payload.toString());
        }
      });
      void consumer.client.subscribeAsync('home/discovery/fake-shutter', { qos: 1 });
    });

    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.entities[0]).toMatchObject({ id: 'volet_salon', kind: 'cover', room: 'salon' });
    expect(manifest.commands.map((c) => c.action)).toEqual(['set']);
    // Le manifeste porte le JSON Schema des params : c'est lui que l'agent lit.
    expect(manifest.commands[0]?.paramsSchema).toHaveProperty('properties.position');
  });

  it('publie son entité cover dès le démarrage, volet ouvert', async () => {
    await vi.waitFor(() => {
      expect(lastCover()).toEqual({ position: 100, state: 'open' });
    });
  });

  it('set {position} descend le volet pas à pas et le pose sur sa consigne', async () => {
    const ack = await send(cmd({ position: 30 }));
    expect(ack.status).toBe('ok');

    await vi.waitFor(() => {
      expect(lastCover()).toEqual({ position: 30, state: 'stopped' });
    });

    // Le mouvement est passé par le bus, il ne s'est pas téléporté : au moins un
    // état intermédiaire `closing` et des positions strictement décroissantes.
    const covers = states.map((entity) => entity.value as CoverValue);
    expect(covers.some((value) => value.state === 'closing')).toBe(true);
    expect(
      covers.filter((value) => value.position > 30 && value.position < 100).length,
    ).toBeGreaterThan(0);
    expect(shutter.position).toBe(30);
  });

  it('action close puis stop fige le volet là où il est', async () => {
    expect((await send(cmd({ action: 'close' }))).status).toBe('ok');
    await vi.waitFor(() => {
      expect(shutter.state).toBe('closing');
      expect(shutter.position).toBeLessThan(100);
    });

    expect((await send(cmd({ action: 'stop' }))).status).toBe('ok');
    const stoppedAt = shutter.position;
    expect(stoppedAt).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(lastCover()).toEqual({ position: stoppedAt, state: 'stopped' });
    });

    // Rien ne bouge plus : le stop a bien arrêté la course, pas seulement l'état.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shutter.position).toBe(stoppedAt);

    expect((await send(cmd({ action: 'open' }))).status).toBe('ok');
    await vi.waitFor(() => {
      expect(lastCover()).toEqual({ position: 100, state: 'open' });
    });
  });

  it('rejette un params inconnu, hors bornes, ambigu, vide, et une mauvaise cible', async () => {
    expect((await send(cmd({ positon: 30 }))).status).toBe('rejected');
    expect((await send(cmd({ position: 130 }))).status).toBe('rejected');
    expect((await send(cmd({ action: 'entrouvrir' }))).status).toBe('rejected');
    expect((await send(cmd({ position: 0, action: 'open' }))).status).toBe('rejected');
    expect((await send(cmd({}))).status).toBe('rejected');
    expect((await send(cmd({ position: 0 }, 'volet_cuisine'))).status).toBe('rejected');
    expect((await send(cmd({ position: 0 }, 'volet_salon', 'teleporter'))).status).toBe('rejected');

    // Aucun de ces refus n'a bougé le volet.
    expect(shutter.position).toBe(100);
  });
});

describe('config', () => {
  it('applique les défauts et n’exige aucune variable', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      entityId: 'volet_salon',
      room: 'salon',
      speedMs: 200,
    });
  });

  it('surcharge chaque valeur par sa variable d’environnement', () => {
    expect(
      loadConfig({
        STELLAR_MQTT_URL: 'mqtt://broker:1883',
        FAKESHUTTER_ENTITY_ID: 'volet_chambre',
        FAKESHUTTER_ROOM: 'chambre',
        FAKESHUTTER_SPEED_MS: '50',
      }),
    ).toEqual({
      mqttUrl: 'mqtt://broker:1883',
      entityId: 'volet_chambre',
      room: 'chambre',
      speedMs: 50,
    });
  });

  it('refuse une vitesse absurde', () => {
    expect(() => loadConfig({ FAKESHUTTER_SPEED_MS: '0' })).toThrow(/strictement positive/);
  });
});
