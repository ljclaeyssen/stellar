import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import type { BusEvent, Entity } from '@stellar/contracts';
import { createCore, type Core } from './core.js';
import type { StaleAlert } from './stale.js';

/**
 * DoD de la phase P5 (spec §16) : « états live via cli ; journal qui grossit ;
 * alerte stale démontrée (pile retirée) ».
 *
 * Le scénario rejoue les trois, de bout en bout : un capteur publie sur un vrai
 * broker, on interroge l'API par HTTP (ce que fait le cli), on regarde le journal
 * grossir, puis on retire la pile — l'horloge du watcher est injectée, la pile est
 * donc « retirée » en avançant le temps de 20 minutes.
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface TrpcResponse<T> {
  result?: { data: T };
}

describe('DoD P5', () => {
  let broker: TestBroker;
  let sensorBus: Bus;
  let coreBus: Bus;
  let core: Core;
  const alerts: BusEvent[] = [];
  /** Horloge du watcher : c'est elle qu'on avance pour « retirer la pile ». */
  let now = Date.UTC(2026, 7, 3, 6, 0, 0);

  const publishTemp = async (value: number): Promise<void> => {
    const entity: Entity = {
      id: 'temp_chambre',
      driver: 'capteur',
      kind: 'temperature',
      room: 'chambre',
      value,
      unit: '°C',
      ts: new Date(now).toISOString(),
    };
    await sensorBus.publishState(entity);
  };

  const httpQuery = async <T>(path: string, input?: unknown): Promise<T> => {
    const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(`http://127.0.0.1:${core.api?.port ?? 0}/${path}${query}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as TrpcResponse<T>).result?.data as T;
  };

  beforeAll(async () => {
    broker = await startTestBroker();
    sensorBus = await createBus({
      url: broker.url,
      clientId: 'capteur-p5',
      driver: 'capteur',
      protocolVersion: 4,
      logger,
    });
    coreBus = await createBus({
      url: broker.url,
      clientId: 'core-p5',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });
    await coreBus.onEvent('core/stale_alert', (event) => alerts.push(event));

    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: 0,
      clock: () => now,
      // Le tour de veille est déclenché à la main dans le test (le timer réel
      // rendrait le scénario non déterministe).
      staleCheckIntervalMs: 3_600_000,
    });
  });

  afterAll(async () => {
    await coreBus.close();
    await sensorBus.close();
    await core.close();
    await broker.close();
  });

  it('états live, journal qui grossit, alerte stale', async () => {
    // 1. États live — vus par HTTP, comme le fera `stellar states`.
    await publishTemp(18.6);
    await vi.waitFor(async () =>
      expect(await httpQuery<Entity[]>('getStates', { kind: 'temperature' })).toHaveLength(1),
    );
    const [live] = await httpQuery<Entity[]>('getStates', { room: 'chambre' });
    expect(live).toMatchObject({ id: 'temp_chambre', value: 18.6, unit: '°C' });
    expect(live?.stale).toBeUndefined();

    // 2. Le journal grossit — et il grossit à chaque publication, pas à chaque
    // changement de valeur.
    const afterFirst = core.journal.count();
    expect(afterFirst).toBeGreaterThan(0);
    now += 60_000;
    await publishTemp(18.6);
    await vi.waitFor(() => expect(core.journal.count()).toBeGreaterThan(afterFirst));

    const rows = await httpQuery<Array<{ entityId: string | null; kind: string | null }>>(
      'journal.query',
      { entityId: 'temp_chambre', order: 'asc' },
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.kind === 'temperature')).toBe(true);

    // 3. La pile est retirée : plus aucune publication, et 20 minutes passent.
    const dernierTs = new Date(now).toISOString();
    now += 20 * 60_000;
    await core.staleWatcher.check();

    // Alerte sur le bus…
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]?.data).toEqual({
      entityId: 'temp_chambre',
      driver: 'capteur',
      kind: 'temperature',
      lastSeenTs: dernierTs,
    } satisfies StaleAlert);

    // … et entité republiée `stale: true`, avec le ts de la dernière donnée réelle.
    await vi.waitFor(async () => {
      const [perimee] = await httpQuery<Entity[]>('getStates', { kind: 'temperature' });
      expect(perimee?.stale).toBe(true);
      expect(perimee?.ts).toBe(dernierTs);
    });

    // Le fait « cette entité est périmée » est lui aussi dans le journal.
    const apres = await httpQuery<Array<{ payload: string; topic: string }>>('journal.query', {
      entityId: 'temp_chambre',
    });
    expect(apres[0]?.payload).toContain('"stale":true');
  });
});
