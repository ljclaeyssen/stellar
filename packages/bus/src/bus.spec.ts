import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ackTopic, cmdTopic, type Ack, type Command, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { ACK_FILTER, createBus, resolveResponseTopic, type Bus } from './bus.js';
import type { Logger } from './logger.js';

/** Logger silencieux qui mémorise ce qui a été émis (pas de bruit dans la sortie de test). */
function recordingLogger(): Logger & { entries: Array<{ level: string; msg: string }> } {
  const entries: Array<{ level: string; msg: string }> = [];
  const push =
    (level: string) =>
    (msg: string): void => {
      entries.push({ level, msg });
    };
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

const cmd = (overrides: Partial<Command> = {}): Command => ({
  id: randomUUID(),
  target: 'clim_salon',
  action: 'set',
  params: { targetTemp: 21 },
  issuedBy: 'cli',
  ts: new Date().toISOString(),
  ...overrides,
});

describe('bus — robustesse du dispatch', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;
  let driverLog: ReturnType<typeof recordingLogger>;
  let consumerLog: ReturnType<typeof recordingLogger>;

  beforeEach(async () => {
    broker = await startTestBroker();
    driverLog = recordingLogger();
    consumerLog = recordingLogger();
    driverBus = await createBus({
      url: broker.url,
      clientId: `driver-${randomUUID()}`,
      driver: 'fake',
      protocolVersion: 4,
      logger: driverLog,
    });
    consumer = await createBus({
      url: broker.url,
      clientId: `consumer-${randomUUID()}`,
      driver: 'consumer',
      protocolVersion: 4,
      logger: consumerLog,
    });
  });

  afterEach(async () => {
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('jette une commande invalide sans invoquer le handler', async () => {
    const handled: Command[] = [];
    await driverBus.onCommand((c): Ack => {
      handled.push(c);
      return { commandId: c.id, status: 'ok' };
    });

    await consumer.client.publishAsync(
      cmdTopic('fake', 'clim_salon'),
      JSON.stringify({ id: 'pas-un-uuid', target: 'clim_salon', action: 'set' }),
      { qos: 1 },
    );
    // Commande valide en sentinelle : quand elle est traitée, l'invalide est passée.
    const ack = await consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 });

    expect(ack.status).toBe('ok');
    expect(handled).toHaveLength(1);
    expect(driverLog.entries).toContainEqual({ level: 'warn', msg: 'commande invalide, jetée' });
  });

  it('renvoie un ack rejected quand le handler lève', async () => {
    await driverBus.onCommand((): Ack => {
      throw new Error('clim injoignable');
    });

    const ack = await consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 });
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('clim injoignable');
  });

  it('jette un ack invalide (la commande finit en timeout)', async () => {
    const command = cmd();
    // Le driver répond n'importe quoi sur le topic d'ack.
    await driverBus.onCommand(async (c): Promise<Ack> => {
      await driverBus.client.publishAsync(
        ackTopic(c.id),
        JSON.stringify({ commandId: c.id, status: 'peut-être' }),
        { qos: 1 },
      );
      // ack conforme mais pour un autre commandId : ignoré côté consumer
      return { commandId: randomUUID(), status: 'ok' };
    });

    const ack = await consumer.sendCommand(command, { driver: 'fake', timeoutMs: 600 });
    expect(ack.status).toBe('timeout');
    await vi.waitFor(() =>
      expect(consumerLog.entries).toContainEqual({ level: 'warn', msg: 'ack invalide, jeté' }),
    );
    expect(consumerLog.entries).toContainEqual({
      level: 'debug',
      msg: 'ack sans commande en attente, ignoré',
    });
  });

  it('jette un event invalide et laisse passer les suivants', async () => {
    const types: string[] = [];
    await consumer.onEvent('fake/+', (event) => types.push(event.type));

    await driverBus.client.publishAsync(
      'home/event/fake/bidon',
      JSON.stringify({ driver: 'fake', ts: 'hier soir' }),
      { qos: 1 },
    );
    await driverBus.publishEvent({
      driver: 'fake',
      type: 'button_pressed',
      ts: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(types).toContain('button_pressed'));
    expect(types).toHaveLength(1);
    expect(consumerLog.entries).toContainEqual({ level: 'warn', msg: 'event invalide, jeté' });
  });

  it('jette un payload non-JSON sans casser le dispatch', async () => {
    const seen: Entity[] = [];
    await consumer.onState({ kind: 'temperature' }, (entity) => seen.push(entity));

    await driverBus.client.publishAsync('home/state/fake/temp_salon', '{ ceci n’est pas du JSON', {
      qos: 1,
    });
    await driverBus.publishState({
      id: 'temp_salon',
      driver: 'fake',
      kind: 'temperature',
      value: 19.2,
      ts: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(consumerLog.entries).toContainEqual({ level: 'warn', msg: 'payload illisible, jeté' });
    expect(consumerLog.entries.some((e) => e.level === 'error')).toBe(false);
  });

  it('traite un payload state vide comme une suppression d’entité', async () => {
    const deleted: Array<{ driver: string; entityId: string }> = [];
    const seen: Entity[] = [];
    await consumer.onState({}, (entity) => seen.push(entity));
    await consumer.onStateDeleted((parts) => deleted.push(parts));

    await driverBus.publishState({
      id: 'temp_salon',
      driver: 'fake',
      kind: 'temperature',
      value: 19.2,
      ts: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // Effacement du retained : payload vide (sémantique MQTT).
    await driverBus.client.publishAsync('home/state/fake/temp_salon', '', {
      qos: 1,
      retain: true,
    });

    await vi.waitFor(() =>
      expect(deleted).toContainEqual({ driver: 'fake', entityId: 'temp_salon' }),
    );
    expect(seen).toHaveLength(1); // aucun onState parasite
  });
});

describe('bus — souscriptions d’ack', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;

  beforeEach(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: `driver-${randomUUID()}`,
      driver: 'fake',
      protocolVersion: 4,
      logger: recordingLogger(),
    });
    consumer = await createBus({
      url: broker.url,
      clientId: `consumer-${randomUUID()}`,
      driver: 'consumer',
      protocolVersion: 4,
      logger: recordingLogger(),
    });
  });

  afterEach(async () => {
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('ne souscrit `home/ack/+` qu’une fois, quel que soit le nombre de commandes', async () => {
    await driverBus.onCommand((c): Ack => ({ commandId: c.id, status: 'ok' }));
    const subscribeSpy = vi.spyOn(consumer.client, 'subscribeAsync');

    const first = await consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 });
    const second = await consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 });
    const third = await consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 });

    expect([first.status, second.status, third.status]).toEqual(['ok', 'ok', 'ok']);
    const ackSubs = subscribeSpy.mock.calls.filter((call) => call[0] === ACK_FILTER);
    expect(ackSubs).toHaveLength(1);
    // et surtout : aucune souscription par commandId
    expect(subscribeSpy.mock.calls.some((call) => String(call[0]).startsWith('home/ack/c'))).toBe(
      false,
    );
    subscribeSpy.mockRestore();
  });

  it('ne souscrit qu’une fois même sur des commandes concurrentes', async () => {
    await driverBus.onCommand((c): Ack => ({ commandId: c.id, status: 'ok' }));
    const subscribeSpy = vi.spyOn(consumer.client, 'subscribeAsync');

    const acks = await Promise.all([
      consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 }),
      consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 }),
      consumer.sendCommand(cmd(), { driver: 'fake', timeoutMs: 2_000 }),
    ]);

    expect(acks.map((a) => a.status)).toEqual(['ok', 'ok', 'ok']);
    expect(subscribeSpy.mock.calls.filter((call) => call[0] === ACK_FILTER)).toHaveLength(1);
    subscribeSpy.mockRestore();
  });

  it('idempotence : la même commande republiée n’invoque le handler qu’une fois', async () => {
    const handled: string[] = [];
    let counter = 0;
    await driverBus.onCommand((c): Ack => {
      handled.push(c.id);
      counter += 1;
      return { commandId: c.id, status: 'ok', reason: `run-${counter}` };
    });

    const acks: Ack[] = [];
    await consumer.client.subscribeAsync(ACK_FILTER, { qos: 1 });
    consumer.client.on('message', (topic, payload) => {
      if (topic.startsWith('home/ack/')) acks.push(JSON.parse(payload.toString()) as Ack);
    });

    const command = cmd();
    const publish = async (): Promise<void> => {
      await consumer.client.publishAsync(
        cmdTopic('fake', command.target),
        JSON.stringify(command),
        { qos: 1 },
      );
    };
    await publish();
    await vi.waitFor(() => expect(acks).toHaveLength(1));
    await publish();
    await vi.waitFor(() => expect(acks).toHaveLength(2));

    expect(handled).toEqual([command.id]);
    expect(acks[0]).toEqual(acks[1]);
    expect(acks[0]?.reason).toBe('run-1');
  });
});

describe('bus — connexion et timeouts', () => {
  it('tient le timeout d’ack même quand le broker est tombé', async () => {
    const broker = await startTestBroker();
    const bus = await createBus({
      url: broker.url,
      clientId: `orphan-${randomUUID()}`,
      driver: 'orphan',
      protocolVersion: 4,
      reconnectMinMs: 60_000, // pas de reconnexion : le client reste hors ligne
      logger: recordingLogger(),
    });

    // On coupe d'abord la connexion (sinon aedes attend ses clients), puis le broker.
    bus.client.stream.destroy();
    await broker.close();

    const started = Date.now();
    const ack = await bus.sendCommand(cmd(), { driver: 'fake', timeoutMs: 300 });
    expect(ack.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);

    await bus.close();
  });

  it('rejette vite avec connectTimeoutMs si le broker est injoignable', async () => {
    const started = Date.now();
    await expect(
      createBus({
        url: 'mqtt://127.0.0.1:1',
        clientId: `nobody-${randomUUID()}`,
        driver: 'nobody',
        protocolVersion: 4,
        connectTimeoutMs: 300,
        logger: recordingLogger(),
      }),
    ).rejects.toThrow(/broker injoignable/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('close() est idempotent', async () => {
    const broker = await startTestBroker();
    const bus = await createBus({
      url: broker.url,
      clientId: `closer-${randomUUID()}`,
      driver: 'closer',
      protocolVersion: 4,
      logger: recordingLogger(),
    });
    await bus.close();
    await expect(bus.close()).resolves.toBeUndefined();
    await broker.close();
  });
});

describe('resolveResponseTopic', () => {
  const commandId = '0b8e7c5e-1d2f-4a3b-9c8d-7e6f5a4b3c2d';

  it('préfère le response-topic MQTT 5 quand il est présent', () => {
    expect(
      resolveResponseTopic(commandId, { properties: { responseTopic: 'home/ack/custom' } }),
    ).toBe('home/ack/custom');
  });

  it('retombe sur home/ack/<commandId> sans propriétés MQTT 5', () => {
    expect(resolveResponseTopic(commandId)).toBe(ackTopic(commandId));
    expect(resolveResponseTopic(commandId, {})).toBe(ackTopic(commandId));
    expect(resolveResponseTopic(commandId, { properties: {} })).toBe(ackTopic(commandId));
    expect(resolveResponseTopic(commandId, { properties: { responseTopic: '' } })).toBe(
      ackTopic(commandId),
    );
  });
});
