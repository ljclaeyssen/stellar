import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { stateTopic, type Entity } from '@stellar/contracts';
import { createAppRouter } from './api.js';
import { createCore, type Core } from './core.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const entity = (id: string, kind: Entity['kind'], room: string, value: unknown): Entity => ({
  id,
  driver: 'fake',
  kind,
  room,
  value,
  ts: new Date().toISOString(),
});

/**
 * Intégration : un faux driver publie sur un vrai broker, le core journalise et
 * l'API (appelée en process, sans client tRPC) relit.
 */
describe('core — journal alimenté par le bus et relu par l’API', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let applianceBus: Bus;
  let coreBus: Bus;
  let core: Core;
  let api: ReturnType<ReturnType<typeof createAppRouter>['createCaller']>;

  beforeAll(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: 'fake-driver-core',
      driver: 'fake',
      protocolVersion: 4,
      logger,
    });
    // Un second « driver » qui accepte les commandes : nécessaire pour produire un
    // vrai couple cmd/ack sur le bus.
    applianceBus = await createBus({
      url: broker.url,
      clientId: 'appareil-core',
      driver: 'appareil',
      protocolVersion: 4,
      logger,
    });
    await applianceBus.onCommand((cmd) => ({ commandId: cmd.id, status: 'ok' }));

    coreBus = await createBus({
      url: broker.url,
      clientId: 'core-integration',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });
    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      // Le serveur MCP a sa propre suite (mcp.spec.ts) : ici il n'ajouterait qu'un
      // port à réserver — et un conflit possible avec les suites voisines.
      mcp: { enabled: false },
      // Pas de détection stale ici : elle a sa propre suite, et son horloge réelle
      // ferait du bruit dans le journal.
      staleCheckIntervalMs: 3_600_000,
    });
    api = createAppRouter({ mirror: core.mirror, journal: core.journal }).createCaller({});

    await driverBus.announce({
      driver: 'fake',
      version: '1.2.3',
      entities: [{ id: 'temp_salon', kind: 'temperature', room: 'salon' }],
      commands: [{ action: 'set', paramsSchema: {} }],
    });
  });

  afterAll(async () => {
    await coreBus.close();
    await applianceBus.close();
    await driverBus.close();
    await core.close();
    await broker.close();
  });

  it('journalise les states avec driver, entityId et kind extraits', async () => {
    const before = core.journal.count();
    await driverBus.publishState(entity('temp_salon', 'temperature', 'salon', 19.5));

    await vi.waitFor(async () =>
      expect(await api.journal.query({ entityId: 'temp_salon' })).toHaveLength(1),
    );
    expect(core.journal.count()).toBeGreaterThan(before);
    const rows = await api.journal.query({ entityId: 'temp_salon' });
    expect(rows[0]).toMatchObject({
      topic: stateTopic('fake', 'temp_salon'),
      driver: 'fake',
      entityId: 'temp_salon',
      kind: 'temperature',
      issuedBy: null,
    });
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ value: 19.5 });
  });

  it('journalise chaque republication, même identique (le journal est un fait)', async () => {
    const repete = entity('temp_repete', 'temperature', 'cave', 11.1);
    await driverBus.publishState(repete);
    await driverBus.publishState({ ...repete, ts: new Date().toISOString() });
    await driverBus.publishState({ ...repete, ts: new Date().toISOString() });

    await vi.waitFor(async () =>
      expect(await api.journal.query({ entityId: 'temp_repete' })).toHaveLength(3),
    );
  });

  it('journalise la commande (avec issuedBy) et son ack', async () => {
    const commandId = randomUUID();
    const ack = await driverBus.sendCommand(
      {
        id: commandId,
        target: 'clim_salon',
        action: 'set',
        params: { targetTemp: 21 },
        issuedBy: 'cli',
        ts: new Date().toISOString(),
      },
      { driver: 'appareil' },
    );
    expect(ack.status).toBe('ok');

    await vi.waitFor(async () =>
      expect(await api.journal.query({ entityId: 'clim_salon' })).toHaveLength(1),
    );
    const [cmdRow] = await api.journal.query({ entityId: 'clim_salon' });
    expect(cmdRow).toMatchObject({
      topic: 'home/cmd/appareil/clim_salon',
      driver: 'appareil',
      entityId: 'clim_salon',
      kind: null,
      issuedBy: 'cli',
    });

    await vi.waitFor(async () => {
      const rows = await api.journal.query({ limit: 500 });
      expect(rows.some((row) => row.topic === `home/ack/${commandId}`)).toBe(true);
    });
  });

  it('journalise aussi ce que le miroir refuse (state invalide) et les effacements', async () => {
    await driverBus.client.publishAsync(
      stateTopic('fake', 'temp_pourri'),
      JSON.stringify({ id: 'temp_pourri', driver: 'fake', kind: 'temperature', value: 'NaN°C' }),
      { qos: 1 },
    );
    await driverBus.client.publishAsync(stateTopic('fake', 'temp_efface'), '', {
      qos: 1,
      retain: true,
    });

    await vi.waitFor(async () =>
      expect(await api.journal.query({ entityId: 'temp_pourri' })).toHaveLength(1),
    );
    // Le miroir l'a jeté (contrat invalide) ; le journal l'a gardé, sans `kind`
    // extrait puisque l'enveloppe n'est pas fiable — mais avec le payload brut.
    expect(core.mirror.getState('temp_pourri')).toBeUndefined();
    expect((await api.journal.query({ entityId: 'temp_pourri' }))[0]?.payload).toContain('NaN');

    await vi.waitFor(async () => {
      const rows = await api.journal.query({ limit: 500 });
      const efface = rows.find((row) => row.topic === stateTopic('fake', 'temp_efface'));
      expect(efface?.payload).toBe('');
    });
  });

  it('sert les états par sélecteur et l’état d’une entité', async () => {
    await driverBus.publishState(entity('presence_chambre', 'presence', 'chambre', true));
    await vi.waitFor(async () => expect(await api.getState('presence_chambre')).not.toBeNull());

    const salon = await api.getStates({ room: 'salon' });
    expect(salon.map((e) => e.id)).toContain('temp_salon');
    expect(await api.getStates({ kind: 'presence' })).toHaveLength(1);
    expect(await api.getState('inconnue')).toBeNull();
  });

  it('agrège capacités et santé des drivers', async () => {
    await vi.waitFor(async () => expect(await api.capabilities()).toHaveLength(1));
    const [manifest] = await api.capabilities();
    expect(manifest).toMatchObject({ driver: 'fake', version: '1.2.3' });

    await vi.waitFor(async () => {
      const health = await api.health();
      expect(health.find((h) => h.driver === 'fake')?.status).toBe('online');
    });
  });

  it('rejette une entrée de journal malformée', async () => {
    await expect(api.journal.query({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(api.journal.query({ order: 'random' } as never)).rejects.toThrow(/order/);
    await expect(api.journal.query({ from: 'hier' })).rejects.toThrow(/ISO 8601/);
    await expect(api.getState('')).rejects.toThrow(/id/);
  });
});
