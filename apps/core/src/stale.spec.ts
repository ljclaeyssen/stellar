import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import type { BusEvent, Entity } from '@stellar/contracts';
import { createMirror, type Mirror } from './mirror.js';
import { createStaleWatcher, type StaleAlert, type StaleWatcher } from './stale.js';

const MINUTE = 60_000;
/** Instant de référence des tests — l'horloge du watcher est injectée. */
const NOW = Date.UTC(2026, 7, 3, 6, 0, 0);
const agoIso = (ms: number): string => new Date(NOW - ms).toISOString();

const warnings: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, extra) => {
    warnings.push({ msg, extra });
  },
  error: () => undefined,
};

describe('détection stale (mort silencieuse)', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let coreBus: Bus;
  let mirror: Mirror;
  let watcher: StaleWatcher;
  const alerts: BusEvent[] = [];

  const entity = (id: string, kind: Entity['kind'], value: unknown, ageMs: number): Entity => ({
    id,
    driver: 'fake',
    kind,
    room: 'salon',
    value,
    ts: agoIso(ageMs),
  });

  beforeAll(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: 'fake-driver-stale',
      driver: 'fake',
      protocolVersion: 4,
    });
    coreBus = await createBus({
      url: broker.url,
      clientId: 'core-stale',
      driver: 'core',
      protocolVersion: 4,
    });
    mirror = await createMirror({ bus: coreBus, logger });
    await coreBus.onEvent('core/stale_alert', (event) => alerts.push(event));

    watcher = createStaleWatcher({
      mirror,
      bus: coreBus,
      logger,
      clock: () => NOW,
      // Pas de tick automatique pendant les tests : on appelle `check()` à la main.
      checkIntervalMs: 3_600_000,
    });
  });

  afterAll(async () => {
    watcher.close();
    await coreBus.close();
    await driverBus.close();
    await broker.close();
  });

  beforeEach(() => {
    alerts.length = 0;
    warnings.length = 0;
  });

  /**
   * Les assertions portent sur les alertes DE L'ENTITÉ testée : le watcher balaie
   * tout le miroir, et les entités des tests précédents y restent (retained).
   */
  const alertsFor = (entityId: string): StaleAlert[] =>
    alerts.map((event) => event.data as StaleAlert).filter((alert) => alert.entityId === entityId);

  it('marque stale une température muette depuis 16 min, sans toucher à son ts', async () => {
    const muette = entity('temp_pile', 'temperature', 18.2, 16 * MINUTE);
    await driverBus.publishState(muette);
    await vi.waitFor(() => expect(mirror.getState('temp_pile')).toBeDefined());

    await watcher.check();

    // Republication : `stale: true`, et surtout le `ts` d'ORIGINE — il dit quand la
    // donnée a été vue, pas quand on a constaté qu'elle était périmée.
    await vi.waitFor(() => expect(mirror.getState('temp_pile')?.stale).toBe(true));
    expect(mirror.getState('temp_pile')?.ts).toBe(muette.ts);
    expect(mirror.getState('temp_pile')?.value).toBe(18.2);

    await vi.waitFor(() => expect(alertsFor('temp_pile')).toHaveLength(1));
    expect(alerts[0]?.driver).toBe('core');
    expect(alerts[0]?.type).toBe('stale_alert');
    expect(alertsFor('temp_pile')[0]).toEqual({
      entityId: 'temp_pile',
      driver: 'fake',
      kind: 'temperature',
      lastSeenTs: muette.ts,
    });
    expect(warnings.map((w) => w.msg)).toContain('entité muette, marquée stale');
  });

  it('laisse intacte une entité fraîche', async () => {
    await driverBus.publishState(entity('temp_frais', 'temperature', 20.4, 2 * MINUTE));
    await vi.waitFor(() => expect(mirror.getState('temp_frais')).toBeDefined());

    await watcher.check();

    expect(alertsFor('temp_frais')).toHaveLength(0);
    expect(mirror.getState('temp_frais')?.stale).toBeUndefined();
  });

  it('n’alerte qu’une fois tant que l’entité ne reparle pas, puis à nouveau si elle se retait', async () => {
    const perimee = entity('temp_boucle', 'temperature', 15.1, 20 * MINUTE);
    await driverBus.publishState(perimee);
    await vi.waitFor(() => expect(mirror.getState('temp_boucle')).toBeDefined());

    await watcher.check();
    await vi.waitFor(() => expect(alertsFor('temp_boucle')).toHaveLength(1));

    // Deux tours de plus : ni republication ni alerte supplémentaires.
    await watcher.check();
    await watcher.check();
    expect(alertsFor('temp_boucle')).toHaveLength(1);

    // L'entité reparle (fraîche) : plus de stale, et aucune alerte.
    await driverBus.publishState(entity('temp_boucle', 'temperature', 15.4, MINUTE));
    await vi.waitFor(() => expect(mirror.getState('temp_boucle')?.stale).toBeUndefined());
    await watcher.check();
    expect(alertsFor('temp_boucle')).toHaveLength(1);

    // Elle se retait : nouvelle alerte, portant le nouveau `lastSeenTs`.
    await driverBus.publishState(entity('temp_boucle', 'temperature', 15.9, 30 * MINUTE));
    await vi.waitFor(() => expect(mirror.getState('temp_boucle')?.value).toBe(15.9));
    await watcher.check();
    await vi.waitFor(() => expect(alertsFor('temp_boucle')).toHaveLength(2));
    expect(alertsFor('temp_boucle')[1]?.lastSeenTs).toBe(agoIso(30 * MINUTE));
  });

  it('ne touche jamais à un kind sans seuil', async () => {
    await driverBus.publishState(
      entity('tv_salon', 'media', { power: false }, 10 * 24 * 60 * MINUTE),
    );
    await vi.waitFor(() => expect(mirror.getState('tv_salon')).toBeDefined());

    await watcher.check();

    expect(alertsFor('tv_salon')).toHaveLength(0);
    expect(mirror.getState('tv_salon')?.stale).toBeUndefined();
  });

  it('ne ré-alerte pas un stale déjà posé par le driver (ADR-009)', async () => {
    await driverBus.publishState({
      ...entity(
        'clim_muette',
        'climate',
        {
          power: true,
          mode: 'heat',
          targetTemp: 20,
          fan: 'auto',
        },
        60 * MINUTE,
      ),
      stale: true,
    });
    await vi.waitFor(() => expect(mirror.getState('clim_muette')?.stale).toBe(true));

    await watcher.check();

    expect(alertsFor('clim_muette')).toHaveLength(0);
  });

  it('applique les seuils par kind (presence 5 min, power 2 min)', async () => {
    await driverBus.publishState(entity('presence_salon', 'presence', true, 4 * MINUTE));
    await driverBus.publishState(entity('power_maison', 'power', { va: 1200 }, 3 * MINUTE));
    await vi.waitFor(() => expect(mirror.getState('power_maison')).toBeDefined());

    await watcher.check();

    // presence : 4 min < 5 min → intacte. power : 3 min > 2 min → stale.
    await vi.waitFor(() => expect(alertsFor('power_maison')).toHaveLength(1));
    expect(alertsFor('presence_salon')).toHaveLength(0);
    expect(mirror.getState('presence_salon')?.stale).toBeUndefined();
  });

  it('accepte un seuil surchargé (fusion avec la table par défaut)', async () => {
    const sensible = createStaleWatcher({
      mirror,
      bus: coreBus,
      logger,
      clock: () => NOW,
      checkIntervalMs: 3_600_000,
      thresholds: { humidity: MINUTE },
    });
    await driverBus.publishState(entity('hum_sdb', 'humidity', 62, 2 * MINUTE));
    await vi.waitFor(() => expect(mirror.getState('hum_sdb')).toBeDefined());

    await sensible.check();

    await vi.waitFor(() => expect(alertsFor('hum_sdb')).toHaveLength(1));
    sensible.close();
  });
});
