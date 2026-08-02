import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBus, createLogger, type Bus } from '@stellar/bus';
import type { Entity } from '@stellar/contracts';
import { createMirror, type Mirror } from './mirror.js';
import { startTestBroker, type TestBroker } from './test-broker.js';

const entity = (id: string, kind: Entity['kind'], room: string, value: unknown): Entity => ({
  id,
  driver: 'fake',
  kind,
  room,
  value,
  ts: new Date().toISOString(),
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('core mirror', () => {
  let broker: TestBroker;
  let driver: Bus;
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
    mirror = await createMirror({ bus: coreBus, logger: createLogger('core-test') });
  });

  afterAll(async () => {
    await coreBus.close();
    await driver.close();
    await broker.close();
  });

  it('reconstruit l’état depuis les retained (démarrage après les drivers)', async () => {
    await waitFor(() => mirror.getStates().length > 0);
    expect(mirror.getState('temp_salon')?.value).toBe(19.5);
  });

  it('sélectionne par kind + room et garde le dernier état par entité', async () => {
    await driver.publishState(entity('temp_salon', 'temperature', 'salon', 20.1));
    await driver.publishState(entity('clim_salon', 'climate', 'salon', {
      power: false,
      mode: 'heat',
      targetTemp: 20,
      fan: 'auto',
    }));

    await waitFor(() => mirror.getState('temp_salon')?.value === 20.1);
    await waitFor(() => mirror.getStates({ room: 'salon' }).length === 2);

    expect(mirror.getStates({ kind: 'temperature' })).toHaveLength(1);
    expect(mirror.getStates({ kind: 'temperature', room: 'chambre' })).toHaveLength(0);
    expect(mirror.getStates()).toHaveLength(2);
  });

  it('agrège manifestes discovery et santé des drivers', async () => {
    await waitFor(() => mirror.getManifests().has('fake'));
    expect(mirror.getManifests().get('fake')?.version).toBe('0.1.0');
    await waitFor(() => mirror.getHealth().get('fake')?.status === 'online');
  });

  it('ignore un state invalide', async () => {
    await coreBus.client.publishAsync(
      'home/state/fake/temp_pourri',
      JSON.stringify({ id: 'temp_pourri', driver: 'fake', kind: 'temperature', value: 'NaN°C', ts: new Date().toISOString() }),
      { qos: 1 },
    );
    // laisse le temps au message d'arriver puis vérifie qu'il n'est pas entré
    await new Promise((r) => setTimeout(r, 150));
    expect(mirror.getState('temp_pourri')).toBeUndefined();
  });
});
