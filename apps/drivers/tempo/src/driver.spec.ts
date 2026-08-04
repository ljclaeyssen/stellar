import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, valueOf, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { startSimTempo, type SimTempo } from '@stellar/sim-tempo';
import { loadConfig } from './config.js';
import { ENTITY_ID, startTempoDriver, type ScheduleFn, type TempoDriverHandle } from './driver.js';
import { createOpendataSource } from './opendata.js';
import { createTempoReader } from './reader.js';
import { createRteSource } from './rte.js';
import { verify } from './verify.js';

/**
 * Le driver Tempo contre le simulateur des deux APIs (ADR-010 niveau 2) et un
 * broker aedes.
 *
 * **Deux fausses horloges, et c'est le cœur de la suite** :
 *
 * 1. `clock` — une variable `now` que les tests déplacent. Le driver ET le
 *    simulateur la partagent : sans quoi `sim.setColors({ today })` ne parlerait
 *    pas du même jour Tempo que le driver.
 * 2. `schedule` — la couture du timer de frontière HP/HC. Elle enregistre le
 *    délai calculé et rend un déclencheur manuel. On vérifie ainsi *que le délai
 *    est juste* (60 s à 21 h 59) puis *ce qui est publié à l'échéance*, sans
 *    attendre une heure et sans `vi.useFakeTimers()` — qui gèlerait aussi le
 *    broker aedes et undici, dans la même suite.
 *
 * Le polling, lui, reste sur de vrais timers : `pollMs` descend à 50 ms.
 */
const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`date de test invalide: ${iso}`);
  return ms;
};

/** Un mardi d'été quelconque, 9 h du matin : demain n'est pas encore publié. */
const MATIN_ETE = at('2026-08-03T09:00:00+02:00');
const REQUEST_TIMEOUT_MS = 2_000;

interface Scheduled {
  delayMs: number;
  fire: () => void;
}

describe('tempo-driver contre le simulateur', () => {
  let broker: TestBroker;
  let sim: SimTempo;
  let driverBus: Bus;
  let consumer: Bus;
  let handle: TempoDriverHandle | null;
  let states: Entity[];
  let warns: string[];
  let errors: string[];
  let now: number;
  let scheduled: Scheduled[];

  const clock = (): number => now;

  const schedule: ScheduleFn = (delayMs, callback) => {
    const entry: Scheduled = { delayMs, fire: callback };
    scheduled.push(entry);
    return () => {
      scheduled = scheduled.filter((candidate) => candidate !== entry);
    };
  };

  /** Dernière frontière programmée — c'est toujours celle qui compte. */
  const pending = (): Scheduled => {
    const last = scheduled.at(-1);
    if (last === undefined) throw new Error('aucune frontière programmée');
    return last;
  };

  const logger = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (msg) => warns.push(msg),
    error: (msg) => errors.push(msg),
  });

  const latest = (): Entity => {
    const found = states.filter((entity) => entity.id === ENTITY_ID).at(-1);
    if (found === undefined) throw new Error(`aucun state publié pour ${ENTITY_ID}`);
    return found;
  };

  const tempo = (): unknown => valueOf(latest(), 'tempo');

  const sources = (withRte: boolean) => ({
    ...(withRte
      ? {
          primary: createRteSource({
            baseUrl: sim.url,
            clientId: sim.clientId,
            clientSecret: sim.clientSecret,
            logger: logger(),
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
          }),
        }
      : {}),
    fallback: createOpendataSource({
      baseUrl: sim.url,
      logger: logger(),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    }),
  });

  /** Le driver n'est pas démarré dans `beforeEach` : chaque test choisit son heure. */
  const start = async (options: { withRte?: boolean; pollMs?: number } = {}) => {
    const reader = createTempoReader({ ...sources(options.withRte ?? true), logger: logger() });
    handle = await startTempoDriver({
      bus: driverBus,
      reader,
      logger: logger(),
      pollMs: options.pollMs ?? 50,
      clock,
      schedule,
    });
    return handle;
  };

  beforeEach(async () => {
    warns = [];
    errors = [];
    scheduled = [];
    handle = null;
    now = MATIN_ETE;
    broker = await startTestBroker();
    // Le simulateur partage l'horloge du test : « aujourd'hui » y a le même sens.
    sim = await startSimTempo({ clock });

    driverBus = await createBus({
      url: broker.url,
      clientId: `tempo-driver-${randomUUID()}`,
      driver: 'tempo',
      protocolVersion: 4,
      logger: logger(),
    });
    consumer = await createBus({
      url: broker.url,
      clientId: `test-consumer-${randomUUID()}`,
      driver: 'consumer',
      protocolVersion: 4,
      logger: logger(),
    });
    states = [];
    await consumer.onState({ driver: 'tempo' }, (entity) => states.push(entity));
  });

  afterEach(async () => {
    handle?.close();
    await consumer.close();
    await driverBus.close();
    await sim.close();
    await broker.close();
  });

  it('publie tempo_jour conforme au contrat : bleu, demain inconnue, HP à 9 h', async () => {
    await start();

    await vi.waitFor(() => {
      expect(states.length).toBeGreaterThan(0);
    });
    const entity = latest();
    expect(isKind(entity, 'tempo')).toBe(true);
    expect(entity.driver).toBe('tempo');
    // Percept national : surtout pas de `room` (la couleur n'est pas locale).
    expect(entity.room).toBeUndefined();
    expect(entity.stale).toBeUndefined();
    expect(entity.value).toEqual({
      couleurJour: 'bleu',
      couleurDemain: 'inconnue',
      periode: 'HP',
    });

    // Retained : un abonné arrivé après le démarrage reçoit l'état courant.
    const late = await createBus({
      url: broker.url,
      clientId: `late-${randomUUID()}`,
      driver: 'late',
      protocolVersion: 4,
      logger: logger(),
    });
    const seen: Entity[] = [];
    await late.onState({ kind: 'tempo' }, (entity_) => seen.push(entity_));
    // ≥ 1 et pas === 1 : le retained arrive d'abord, mais sur une machine lente
    // (CI 2 cœurs) le polling du driver a le temps de republier pendant l'attente.
    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    expect(seen[0]?.id).toBe(ENTITY_ID);
    await late.close();
  });

  it('annonce un manifeste discovery retained, sans aucune commande', async () => {
    await start();

    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/tempo' && payload.length > 0) resolve(payload.toString());
      });
      void consumer.client.subscribeAsync('home/discovery/tempo', { qos: 1 });
    });
    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.driver).toBe('tempo');
    expect(manifest.entities).toEqual([{ id: ENTITY_ID, kind: 'tempo' }]);
    // Driver percept pur : on ne pilote pas la couleur du jour.
    expect(manifest.commands).toEqual([]);
  });

  it('après 11 h, la couleur du lendemain est publiée', async () => {
    await start({ pollMs: 60_000 });
    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurDemain: 'inconnue' });
    });

    // RTE publie vers 11 h : le lendemain sort de l'inconnu.
    now = at('2026-08-03T11:30:00+02:00');
    sim.setColors({ tomorrow: 'rouge' });
    await handle?.poll();

    // `poll` a publié, mais la livraison au consommateur est un aller-retour de
    // plus sur le broker : on attend l'état, on ne le suppose pas.
    await vi.waitFor(() => {
      expect(tempo()).toEqual({ couleurJour: 'bleu', couleurDemain: 'rouge', periode: 'HP' });
    });
  });

  it('à 23 h : période HC et couleur du jour commencé à 6 h', async () => {
    now = at('2026-08-03T23:00:00+02:00');
    sim.setColors({ today: 'blanc', tomorrow: 'rouge' });
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toEqual({ couleurJour: 'blanc', couleurDemain: 'rouge', periode: 'HC' });
    });
  });

  it('à 3 h du matin : le jour Tempo courant est celui de la veille (wrap 6 h)', async () => {
    sim.setColorForDay('2026-08-03', 'blanc');
    sim.setColorForDay('2026-08-04', 'rouge');
    now = at('2026-08-04T03:00:00+02:00');
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      // 3 h du matin le 4 : on est encore dans le jour Tempo du 3 (blanc), et
      // « demain » est le jour Tempo du 4 (rouge), qui commencera dans 3 h.
      expect(tempo()).toEqual({ couleurJour: 'blanc', couleurDemain: 'rouge', periode: 'HC' });
    });
  });

  it('bascule HP → HC : republication à 22 h 00 pile, même sans réseau', async () => {
    now = at('2026-08-03T21:59:00+02:00');
    sim.setColors({ today: 'rouge', tomorrow: 'bleu' });
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ periode: 'HP' });
    });
    // La frontière est programmée à la minute près, pas au prochain poll.
    expect(pending().delayMs).toBe(60_000);

    // Les deux sources tombent : la bascule doit tenir sur le seul cache.
    sim.failRte(true);
    sim.failFallback(true);
    const before = states.length;

    now = at('2026-08-03T22:00:00+02:00');
    pending().fire();

    await vi.waitFor(() => {
      expect(states.length).toBeGreaterThan(before);
      expect(tempo()).toEqual({ couleurJour: 'rouge', couleurDemain: 'bleu', periode: 'HC' });
    });
    // Un cycle raté ne suffit pas à déclarer l'entité périmée (ADR-009).
    expect(latest().stale).toBeUndefined();
    // Et la frontière suivante est déjà programmée : 22 h → 6 h, soit 8 h.
    expect(pending().delayMs).toBe(8 * 3_600_000);
  });

  it('bascule HC → HP à 6 h : le jour Tempo change de couleur', async () => {
    sim.setColorForDay('2026-08-03', 'blanc');
    sim.setColorForDay('2026-08-04', 'rouge');
    now = at('2026-08-04T05:59:00+02:00');
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'blanc', periode: 'HC' });
    });
    expect(pending().delayMs).toBe(60_000);

    now = at('2026-08-04T06:00:00+02:00');
    pending().fire();

    await vi.waitFor(() => {
      // Le jour Tempo du 4 commence : la couleur « de demain » devient celle du
      // jour, et le nouveau lendemain (le 5) n'est pas encore publié.
      expect(tempo()).toEqual({ couleurJour: 'rouge', couleurDemain: 'inconnue', periode: 'HP' });
    });
    expect(pending().delayMs).toBe(16 * 3_600_000);
  });

  it('DST : les frontières suivent l’heure de Paris (nuit du 24 au 25 octobre)', async () => {
    sim.setColorForDay('2026-10-24', 'rouge');
    now = at('2026-10-24T21:59:00+02:00');
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'rouge', periode: 'HP' });
    });
    expect(pending().delayMs).toBe(60_000);

    now = at('2026-10-24T22:00:00+02:00');
    pending().fire();

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ periode: 'HC' });
    });
    // Cette nuit-là, 22 h → 6 h dure 9 h réelles (les montres reculent d'une
    // heure à 3 h) : un `+8 h` codé en dur réveillerait le driver à 5 h.
    expect(pending().delayMs).toBe(9 * 3_600_000);
  });

  it('RTE est la source primaire quand les identifiants sont là', async () => {
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'bleu' });
    });
    expect(sim.tokenCalls).toBeGreaterThan(0);
    expect(sim.rteCalendarCalls).toBeGreaterThan(0);
    // Le fallback n'est pas sollicité tant que la source primaire répond.
    expect(sim.fallbackCalls).toBe(0);
  });

  it('RTE en échec : bascule sur l’opendata, loggée en warn', async () => {
    sim.failRte(true);
    await start({ pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'bleu', periode: 'HP' });
    });
    expect(sim.fallbackCalls).toBeGreaterThan(0);
    expect(warns.some((msg) => msg.includes('bascule'))).toBe(true);
    // Une source de repli qui marche, ce n'est pas un état périmé.
    expect(latest().stale).toBeUndefined();
    expect(handle?.stale).toBe(false);
  });

  it('sans identifiants RTE : aucune requête vers RTE, fallback direct', async () => {
    await start({ withRte: false, pollMs: 60_000 });

    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'bleu' });
    });
    expect(sim.tokenCalls).toBe(0);
    expect(sim.rteCalendarCalls).toBe(0);
    expect(sim.fallbackCalls).toBeGreaterThan(0);
  });

  it('les deux sources muettes : stale après 2 cycles, puis retour frais (ADR-009)', async () => {
    await start();
    await vi.waitFor(() => {
      expect(states.length).toBeGreaterThan(0);
    });
    expect(latest().stale).toBeUndefined();

    sim.failRte(true);
    sim.failFallback(true);
    await vi.waitFor(
      () => {
        expect(latest().stale).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(handle?.stale).toBe(true);
    // L'état conservé reste le dernier connu — on ne publie pas d'inconnue.
    expect(tempo()).toMatchObject({ couleurJour: 'bleu' });

    sim.failRte(false);
    sim.failFallback(false);
    sim.setColors({ today: 'rouge' });
    await vi.waitFor(
      () => {
        expect(latest().stale).toBeUndefined();
        expect(tempo()).toMatchObject({ couleurJour: 'rouge' });
      },
      { timeout: 5_000 },
    );
    expect(handle?.stale).toBe(false);
  });

  it('un changement de couleur côté source est reflété au poll suivant', async () => {
    await start();
    await vi.waitFor(() => {
      expect(tempo()).toMatchObject({ couleurJour: 'bleu', couleurDemain: 'inconnue' });
    });

    sim.setColors({ today: 'blanc', tomorrow: 'rouge' });
    await vi.waitFor(() => {
      expect(tempo()).toEqual({ couleurJour: 'blanc', couleurDemain: 'rouge', periode: 'HP' });
    });
  });

  it('verify : dump daté des deux sources, sans aucun secret', async () => {
    sim.setColors({ today: 'rouge', tomorrow: 'blanc' });
    const fixturesDir = join(tmpdir(), `stellar-tempo-fixtures-${randomUUID()}`);
    try {
      const { primary, fallback } = sources(true);
      if (primary === undefined) throw new Error('source RTE attendue');
      const summary = await verify({
        rte: primary,
        fallback,
        rteApiUrl: sim.url,
        fallbackUrl: sim.url,
        fixturesDir,
        logger: logger(),
        clock,
      });

      expect(summary.days).toEqual(['2026-08-03', '2026-08-04']);
      expect(summary.sources.map((source) => source.name)).toEqual(['rte', 'opendata']);
      expect(summary.sources.every((source) => source.ok)).toBe(true);
      // Les deux sources doivent dire la même chose : c'est tout l'intérêt
      // d'interroger les deux au branchement.
      for (const source of summary.sources) {
        expect(source.colors).toEqual({ '2026-08-03': 'rouge', '2026-08-04': 'blanc' });
      }
      expect(summary.value).toEqual({
        couleurJour: 'rouge',
        couleurDemain: 'blanc',
        periode: 'HP',
      });
      // Horodatage aplati : `:` est interdit dans un nom de fichier Windows.
      expect(basename(summary.dumpFile)).toMatch(/^verify-[\d-]+T[\d-]+Z\.json$/);

      const dump = await readFile(summary.dumpFile, 'utf8');
      expect(JSON.parse(dump)).toMatchObject({ days: summary.days });
      expect(dump).not.toContain(sim.clientSecret);
      expect(dump).not.toContain(sim.state.accessToken);
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });

  it('verify sans identifiants RTE : la seule source publique est vérifiée', async () => {
    const fixturesDir = join(tmpdir(), `stellar-tempo-fixtures-${randomUUID()}`);
    try {
      const summary = await verify({
        fallback: sources(false).fallback,
        rteApiUrl: sim.url,
        fallbackUrl: sim.url,
        fixturesDir,
        logger: logger(),
        clock,
      });
      expect(summary.sources.map((source) => source.name)).toEqual(['opendata']);
      expect(sim.tokenCalls).toBe(0);
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

describe('config', () => {
  it('applique les défauts et n’exige rien : le fallback public suffit', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      rteApiUrl: 'https://digital.iservices.rte-france.com',
      fallbackUrl: 'https://www.api-couleur-tempo.fr',
      pollMs: 3_600_000,
      requestTimeoutMs: 10_000,
      fixturesDir: 'apps/drivers/tempo/__fixtures__',
    });
  });

  it('accepte les identifiants RTE, mais seulement par paire', () => {
    expect(loadConfig({ RTE_CLIENT_ID: 'id', RTE_CLIENT_SECRET: 'secret' })).toMatchObject({
      rteClientId: 'id',
      rteClientSecret: 'secret',
    });
    expect(() => loadConfig({ RTE_CLIENT_ID: 'id' })).toThrow(/par paire/);
    expect(() => loadConfig({ RTE_CLIENT_SECRET: 'secret' })).toThrow(/par paire/);
    // Une variable vide vaut absente : un secret non injecté ne doit pas passer
    // pour une configuration à moitié faite.
    expect(loadConfig({ RTE_CLIENT_ID: '', RTE_CLIENT_SECRET: '' })).toMatchObject({
      rteClientId: undefined,
    });
  });

  it('accepte de viser le simulateur et de resserrer la cadence', () => {
    expect(
      loadConfig({
        RTE_API_URL: 'http://127.0.0.1:8844',
        TEMPO_FALLBACK_URL: 'http://127.0.0.1:8844',
        TEMPO_POLL_MS: '250',
      }),
    ).toMatchObject({
      rteApiUrl: 'http://127.0.0.1:8844',
      fallbackUrl: 'http://127.0.0.1:8844',
      pollMs: 250,
    });
  });

  it('refuse une URL qui n’en est pas une, et une cadence absurde', () => {
    expect(() => loadConfig({ RTE_API_URL: 'digital.iservices.rte-france.com' })).toThrow(/http/);
    expect(() => loadConfig({ TEMPO_FALLBACK_URL: 'api-couleur-tempo.fr' })).toThrow(/http/);
    expect(() => loadConfig({ TEMPO_POLL_MS: '0' })).toThrow(/strictement positive/);
  });
});
