import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { stateTopic, type Entity } from '@stellar/contracts';
import { createMirror, type Mirror } from './mirror.js';

const entity = (
  id: string,
  kind: Entity['kind'],
  room: string,
  value: unknown,
  overrides: Partial<Entity> = {},
): Entity => ({
  id,
  driver: 'fake',
  kind,
  room,
  value,
  ts: new Date().toISOString(),
  ...overrides,
});

/** Logger de test : on assert sur les warns plutôt que de polluer stdout. */
const warnings: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, extra) => {
    warnings.push({ msg, extra });
  },
  error: () => undefined,
};
const warnedWith = (msg: string): boolean => warnings.some((w) => w.msg === msg);

describe('core mirror', () => {
  let broker: TestBroker;
  let driver: Bus;
  let other: Bus | undefined;
  let coreBus: Bus;
  let mirror: Mirror;

  beforeAll(async () => {
    broker = await startTestBroker();
    driver = await createBus({
      url: broker.url,
      clientId: 'fake-driver',
      driver: 'fake',
      protocolVersion: 4,
    });
    // Le driver publie AVANT que le core ne démarre : le retained doit suffire.
    await driver.publishState(entity('temp_salon', 'temperature', 'salon', 19.5));
    await driver.announce({ driver: 'fake', version: '0.1.0', entities: [], commands: [] });

    coreBus = await createBus({
      url: broker.url,
      clientId: 'core-test',
      driver: 'core',
      protocolVersion: 4,
    });
    mirror = await createMirror({ bus: coreBus, logger });
  });

  afterAll(async () => {
    await other?.close();
    await coreBus.close();
    await driver.close();
    await broker.close();
  });

  it('reconstruit l’état depuis les retained (démarrage après les drivers)', async () => {
    await vi.waitFor(() => expect(mirror.getState('temp_salon')?.value).toBe(19.5));
  });

  it('sélectionne par kind + room et garde le dernier état par entité', async () => {
    await driver.publishState(entity('temp_salon', 'temperature', 'salon', 20.1));
    await driver.publishState(
      entity('clim_salon', 'climate', 'salon', {
        power: false,
        mode: 'heat',
        targetTemp: 20,
        fan: 'auto',
      }),
    );

    await vi.waitFor(() => expect(mirror.getState('temp_salon')?.value).toBe(20.1));
    await vi.waitFor(() => expect(mirror.getStates({ room: 'salon' })).toHaveLength(2));

    expect(mirror.getStates({ kind: 'temperature' })).toHaveLength(1);
    expect(mirror.getStates({ kind: 'temperature', room: 'chambre' })).toHaveLength(0);
    expect(mirror.getStates()).toHaveLength(2);
  });

  it('agrège manifestes discovery et santé des drivers', async () => {
    await vi.waitFor(() => expect(mirror.getManifests().get('fake')?.version).toBe('0.1.0'));
    await vi.waitFor(() => expect(mirror.getHealth().get('fake')?.status).toBe('online'));
  });

  it('ignore un state invalide', async () => {
    // Publication brute d'un state non conforme (value string pour un kind temperature)…
    await driver.client.publishAsync(
      'home/state/fake/temp_pourri',
      JSON.stringify({
        id: 'temp_pourri',
        driver: 'fake',
        kind: 'temperature',
        value: 'NaN°C',
        ts: new Date().toISOString(),
      }),
      { qos: 1 },
    );
    // … puis d'une sentinelle valide sur la MÊME connexion : quand elle apparaît dans
    // le miroir, l'invalide est forcément déjà passé dans le dispatch (ordre garanti).
    await driver.publishState(entity('temp_sentinelle', 'temperature', 'cave', 11.4));

    await vi.waitFor(() => expect(mirror.getState('temp_sentinelle')).toBeDefined());
    expect(mirror.getState('temp_pourri')).toBeUndefined();
  });

  it('retire une entité quand son retained est effacé (payload vide)', async () => {
    const doomed = entity('temp_garage', 'temperature', 'garage', 8.2);
    await driver.publishState(doomed);
    await vi.waitFor(() => expect(mirror.getState('temp_garage')?.value).toBe(8.2));

    await driver.client.publishAsync(stateTopic('fake', 'temp_garage'), '', {
      qos: 1,
      retain: true,
    });

    await vi.waitFor(() => expect(mirror.getState('temp_garage')).toBeUndefined());
    expect(mirror.getStates({ id: 'temp_garage' })).toHaveLength(0);
  });

  it('conserve les deux entités en collision d’id inter-drivers, warn une fois, la plus récente gagne', async () => {
    other = await createBus({
      url: broker.url,
      clientId: 'autre-driver',
      driver: 'autre',
      protocolVersion: 4,
    });

    // Même id que l'entité déjà publiée par `fake`, mais plus récente.
    const collision = entity('temp_salon', 'temperature', 'bureau', 24.6, {
      driver: 'autre',
      ts: new Date(Date.now() + 60_000).toISOString(),
    });
    await other.publishState(collision);

    await vi.waitFor(() => expect(warnedWith("collision d'entityId entre drivers")).toBe(true));
    const warn = warnings.find((w) => w.msg === "collision d'entityId entre drivers");
    expect(warn?.extra).toEqual({ id: 'temp_salon', drivers: ['autre', 'fake'] });

    // Le dernier gagne sur `getState`, mais aucune des deux entités n'est perdue.
    expect(mirror.getState('temp_salon')?.value).toBe(24.6);
    expect(mirror.getStates({ id: 'temp_salon' })).toHaveLength(2);
    expect(mirror.getStates({ id: 'temp_salon', driver: 'fake' })[0]?.value).toBe(20.1);

    // Un second message en collision ne doit pas reproduire le warn.
    const before = warnings.filter((w) => w.msg === "collision d'entityId entre drivers").length;
    await other.publishState({ ...collision, value: 25.1 });
    await vi.waitFor(() => expect(mirror.getState('temp_salon')?.value).toBe(25.1));
    expect(warnings.filter((w) => w.msg === "collision d'entityId entre drivers")).toHaveLength(
      before,
    );
  });

  it('jette un health non conforme', async () => {
    await driver.client.publishAsync(
      'home/health/health_pourri',
      JSON.stringify({ status: 'peut-être', ts: 'hier' }),
      { qos: 1 },
    );
    await vi.waitFor(() => expect(warnedWith('health invalide, jeté')).toBe(true));
    expect(mirror.getHealth().has('health_pourri')).toBe(false);
  });

  it('jette un manifeste non conforme', async () => {
    await driver.client.publishAsync(
      'home/discovery/manifeste_pourri',
      JSON.stringify({ driver: 'manifeste_pourri' }),
      { qos: 1 },
    );
    await vi.waitFor(() => expect(warnedWith('manifeste invalide, jeté')).toBe(true));
    expect(mirror.getManifests().has('manifeste_pourri')).toBe(false);
  });

  it('survit à un payload JSON cassé', async () => {
    await driver.client.publishAsync('home/health/json_casse', '{ ceci n’est pas du json', {
      qos: 1,
    });
    await vi.waitFor(() => expect(warnedWith('payload illisible, jeté')).toBe(true));

    // Le miroir reste opérationnel après l'incident.
    await driver.publishState(entity('temp_apres_crash', 'temperature', 'cave', 12.7));
    await vi.waitFor(() => expect(mirror.getState('temp_apres_crash')?.value).toBe(12.7));
  });

  it('voit la transition health online → offline d’un driver', async () => {
    const mortal = await createBus({
      url: broker.url,
      clientId: 'mortal-driver',
      driver: 'mortal',
      protocolVersion: 4,
      reconnectMinMs: 60_000, // pas de reconnexion pendant le test
    });
    await vi.waitFor(() => expect(mirror.getHealth().get('mortal')?.status).toBe('online'));

    // close() publie le health 'offline' retained avant de se déconnecter.
    await mortal.close();
    await vi.waitFor(() => expect(mirror.getHealth().get('mortal')?.status).toBe('offline'));
  });
});
