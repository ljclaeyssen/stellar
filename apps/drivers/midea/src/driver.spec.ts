import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, valueOf, type Ack, type Entity } from '@stellar/contracts';
import { createFakeAppliance, type FakeAppliance } from '@stellar/midea-protocol/testing';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { loadConfig, loadUnits, MideaUnits, type MideaUnit } from './config.js';
import {
  buildManifest,
  staleAfterCycles,
  startMideaDriver,
  temperatureIdOf,
  type MideaDriverHandle,
} from './driver.js';
import { verify } from './verify.js';

const TOKEN = 'TOKEN-9C06A28C7223C0268765BADE044DA029';
const KEY = 'KEY-022BA2C782A41BFFBED33B769AA0889E';

/** Le parc réel : 3 clims (spec §3). Les valeurs id/token/key sont factices. */
const UNITS: MideaUnits = [
  { entityId: 'clim_salon', room: 'salon', host: '192.168.5.121', id: '1', token: TOKEN, key: KEY },
  {
    entityId: 'clim_entree',
    room: 'entree',
    host: '192.168.5.122',
    id: '2',
    token: TOKEN,
    key: KEY,
  },
  {
    entityId: 'clim_chambre',
    room: 'chambre',
    host: '192.168.5.123',
    id: '3',
    token: TOKEN,
    key: KEY,
  },
];

const CLIM_SALON = 'clim_salon';
const TEMP_SALON = 'temp_salon_clim';

/**
 * Cadences resserrées : on teste la *logique*, pas la patience.
 *
 * Le seuil « injoignable > 5 min » de la spec est un nombre de cycles ratés,
 * `ceil(staleAfterMs / pollMs)`, plancher 2 (cf. `staleAfterCycles`). Ici
 * `ceil(150 / 30) = 5` cycles × 30 ms ≈ 150 ms — exactement le rapport
 * `300 000 / 45 000 = 7` cycles de la prod, à l'échelle de temps près.
 */
const POLL_MS = 30;
const STALE_AFTER_MS = 150;

const cmd = (target: string, params: Record<string, unknown>, action = 'set') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('midea-driver contre le fake du wrapper (ADR-010 niveau 2)', () => {
  // Broker recréé à chaque test : sinon les messages *retained* fuiraient de l'un
  // à l'autre et un état « frais » d'un test précédent masquerait un `stale`.
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;
  let handle: MideaDriverHandle;
  let fakes: Map<string, FakeAppliance>;
  let states: Entity[];
  let errors: string[];

  const logger = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg) => errors.push(msg),
  });

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'midea', timeoutMs: 3_000 });

  const latest = (id: string): Entity => {
    const found = states.filter((entity) => entity.id === id).at(-1);
    if (found === undefined) throw new Error(`aucun state publié pour ${id}`);
    return found;
  };

  const fakeOf = (entityId: string): FakeAppliance => {
    const fake = fakes.get(entityId);
    if (fake === undefined) throw new Error(`pas de fake pour ${entityId}`);
    return fake;
  };

  beforeEach(async () => {
    errors = [];
    fakes = new Map();
    broker = await startTestBroker();

    driverBus = await createBus({
      url: broker.url,
      clientId: `midea-driver-${randomUUID()}`,
      driver: 'midea',
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
    await consumer.onState({ driver: 'midea' }, (entity) => states.push(entity));

    handle = await startMideaDriver({
      bus: driverBus,
      units: UNITS,
      logger: logger(),
      pollMs: POLL_MS,
      staleAfterMs: STALE_AFTER_MS,
      createAppliance: (unit: MideaUnit) => {
        // Une T° différente par pièce : sans ça, un percept publié sur la mauvaise
        // entité passerait inaperçu.
        const indoor = { salon: 19.8, entree: 18.1, chambre: 17.4 }[unit.room] ?? 20;
        const fake = createFakeAppliance({ id: unit.id, status: { indoorTemperature: indoor } });
        fakes.set(unit.entityId, fake);
        return fake;
      },
    });
  });

  afterEach(async () => {
    handle.close();
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('publie les 3 unités en climate + temperature retained conformes au contrat', async () => {
    const expected = UNITS.flatMap((unit) => [unit.entityId, temperatureIdOf(unit)]);
    await vi.waitFor(() => {
      expect([...new Set(states.map((entity) => entity.id))].sort()).toEqual([...expected].sort());
    });

    const clim = latest(CLIM_SALON);
    expect(isKind(clim, 'climate')).toBe(true);
    expect(clim.room).toBe('salon');
    expect(clim.value).toEqual({
      power: true,
      mode: 'heat',
      targetTemp: 20.5,
      indoorTemp: 19.8,
      fan: 'auto',
    });
    expect(clim.stale).toBeUndefined();

    const temp = latest(TEMP_SALON);
    expect(isKind(temp, 'temperature')).toBe(true);
    expect(temp).toMatchObject({ value: 19.8, unit: '°C', room: 'salon' });
    // Chaque pièce a bien sa propre sonde.
    expect(latest('temp_entree_clim')).toMatchObject({ value: 18.1, room: 'entree' });
    expect(latest('temp_chambre_clim')).toMatchObject({ value: 17.4, room: 'chambre' });

    // Retained : un abonné arrivé *après* le démarrage reçoit tout l'inventaire.
    const late = await createBus({
      url: broker.url,
      clientId: `late-${randomUUID()}`,
      driver: 'late',
      protocolVersion: 4,
      logger: logger(),
    });
    const seen = new Set<string>();
    await late.onState({ driver: 'midea' }, (entity) => seen.add(entity.id));
    await vi.waitFor(() => {
      expect(seen.size).toBe(expected.length);
    });
    await late.close();
  });

  it('annonce un manifeste discovery retained valide (6 entités + commande set)', async () => {
    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/midea' && payload.length > 0) resolve(payload.toString());
      });
      void consumer.client.subscribeAsync('home/discovery/midea', { qos: 1 });
    });
    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.driver).toBe('midea');
    expect(manifest.entities).toHaveLength(6);
    expect(manifest.entities).toContainEqual({
      id: CLIM_SALON,
      kind: 'climate',
      room: 'salon',
    });
    expect(manifest.entities).toContainEqual({
      id: TEMP_SALON,
      kind: 'temperature',
      room: 'salon',
      unit: '°C',
    });
    expect(manifest.commands.map((command) => command.action)).toEqual(['set']);
    expect(manifest.commands[0]?.paramsSchema).toHaveProperty('properties');
  });

  it('le polling suit l’unité : une T° changée remonte sur les deux entités', async () => {
    await vi.waitFor(() => {
      expect(valueOf(latest(CLIM_SALON), 'climate')?.indoorTemp).toBe(19.8);
    });

    fakeOf(CLIM_SALON).setIndoor(22.6);

    await vi.waitFor(() => {
      expect(valueOf(latest(CLIM_SALON), 'climate')?.indoorTemp).toBe(22.6);
      expect(latest(TEMP_SALON).value).toBe(22.6);
    });
    // Les autres unités n'ont pas bougé.
    expect(latest('temp_entree_clim').value).toBe(18.1);
  });

  it('DoD P4 : set targetTemp/mode/power → unité mise à jour, ack ok, état frais immédiat', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === CLIM_SALON)).toBe(true);
    });
    const published = states.filter((entity) => entity.id === CLIM_SALON).length;

    const ack = await send(
      cmd(CLIM_SALON, { power: true, mode: 'cool', targetTemp: 22, fan: 'low' }),
    );
    expect(ack.status).toBe('ok');

    // Le fake — donc l'unité — a bien reçu la traduction.
    expect(fakeOf(CLIM_SALON).status).toMatchObject({
      powerOn: true,
      mode: 2,
      temperatureSetpoint: 22,
      fanSpeed: 40,
    });

    // Resynchronisation immédiate : le statut rendu par setStatus est republié
    // sans attendre le prochain poll.
    await vi.waitFor(() => {
      expect(states.filter((entity) => entity.id === CLIM_SALON).length).toBeGreaterThan(published);
      expect(valueOf(latest(CLIM_SALON), 'climate')).toMatchObject({
        power: true,
        mode: 'cool',
        targetTemp: 22,
        fan: '40',
      });
    });

    // Les autres unités sont restées où elles étaient.
    expect(fakeOf('clim_entree').status).toMatchObject({ mode: 4, temperatureSetpoint: 20.5 });
  });

  it('rejette les params invalides et les cibles inconnues sans rien envoyer à l’unité', async () => {
    const before = fakeOf(CLIM_SALON).calls.setStatus;

    expect((await send(cmd(CLIM_SALON, {}))).status).toBe('rejected');
    expect((await send(cmd(CLIM_SALON, { targetTemp: 35 }))).status).toBe('rejected');
    expect((await send(cmd(CLIM_SALON, { targetTemp: 12 }))).status).toBe('rejected');
    expect((await send(cmd(CLIM_SALON, { mode: 'turbo' }))).status).toBe('rejected');
    expect((await send(cmd(CLIM_SALON, { brightness: 50 }))).status).toBe('rejected');
    expect((await send(cmd(CLIM_SALON, { targetTemp: 20 }, 'toggle'))).status).toBe('rejected');

    // `fixed` est un état lisible (fanSpeed 101) mais non écrivable — erreur de mapping.
    const fixed = await send(cmd(CLIM_SALON, { fan: 'fixed' }));
    expect(fixed.status).toBe('rejected');
    expect(fixed.reason).toContain('vitesse de ventilation inconnue');

    // Le percept de température n'est pas un actionneur.
    const percept = await send(cmd(TEMP_SALON, { targetTemp: 20 }));
    expect(percept.status).toBe('rejected');
    expect(percept.reason).toContain('entité inconnue');

    const inconnue = await send(cmd('clim_cave', { targetTemp: 20 }));
    expect(inconnue.status).toBe('rejected');
    expect(inconnue.reason).toContain('entité inconnue');

    expect(fakeOf(CLIM_SALON).calls.setStatus).toBe(before);
  });

  it('unité muette > seuil : les DEUX entités stale, commandes rejetées, voisines intactes (ADR-009)', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === TEMP_SALON)).toBe(true);
    });

    fakeOf(CLIM_SALON).setUnreachable(true);

    await vi.waitFor(() => {
      expect(latest(CLIM_SALON).stale).toBe(true);
      expect(latest(TEMP_SALON).stale).toBe(true);
    });

    // Indépendance des unités : une clim muette n'en rend pas deux autres suspectes.
    expect(latest('clim_entree').stale).toBeUndefined();
    expect(latest('temp_chambre_clim').stale).toBeUndefined();
    expect(handle.units.filter((unit) => unit.stale).map((unit) => unit.entityId)).toEqual([
      CLIM_SALON,
    ]);

    // Jamais d'ack `ok` sur une unité qu'on sait injoignable (ADR-009).
    const ack = await send(cmd(CLIM_SALON, { targetTemp: 21 }));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('injoignable');
    // …mais les voisines répondent toujours.
    expect((await send(cmd('clim_entree', { targetTemp: 21 }))).status).toBe('ok');

    // Alerte loggée une seule fois, pas à chaque cycle raté.
    expect(errors.filter((msg) => msg.includes('injoignable'))).toHaveLength(1);

    // Retour de l'unité → resynchronisation et republication fraîche.
    fakeOf(CLIM_SALON).setIndoor(21.9);
    fakeOf(CLIM_SALON).setUnreachable(false);
    await vi.waitFor(() => {
      expect(latest(CLIM_SALON).stale).toBeUndefined();
      expect(latest(TEMP_SALON).value).toBe(21.9);
      expect(latest(TEMP_SALON).stale).toBeUndefined();
    });
    expect(handle.units.every((unit) => !unit.stale)).toBe(true);
  });

  it('un échec ponctuel est toléré : failNext(1) ne rend rien stale', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === CLIM_SALON)).toBe(true);
    });

    fakeOf(CLIM_SALON).failNext(1);

    // Le cycle raté est consommé, puis plusieurs cycles réussissent.
    await vi.waitFor(() => {
      expect(fakeOf(CLIM_SALON).calls.getStatus).toBeGreaterThan(handle.staleAfterCycles + 2);
    });
    expect(latest(CLIM_SALON).stale).toBeUndefined();
    expect(latest(TEMP_SALON).stale).toBeUndefined();
    expect(handle.units.every((unit) => !unit.stale)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('jitter : les unités ne se synchronisent pas sur la même cadence', async () => {
    // 8 tirages : comparer des SÉQUENCES, jamais des agrégats — la somme de
    // 4 tirages dans [27..33] collisionne trop souvent (flake réel constaté :
    // 120 === 120, pile la moyenne). Deux séquences de 8 tirages identiques
    // ont une probabilité ~(1/7)^8 ≈ 2e-7 : négligeable.
    await vi.waitFor(() => {
      expect(handle.units.every((unit) => unit.delays.length >= 8)).toBe(true);
    });
    const [salon, entree] = handle.units;

    // Chaque délai reste dans la fenêtre ±10 % (spec §9 : polling doux, cadence tenue).
    for (const unit of handle.units) {
      for (const delay of unit.delays) {
        expect(delay).toBeGreaterThanOrEqual(Math.round(POLL_MS * 0.9));
        expect(delay).toBeLessThanOrEqual(Math.round(POLL_MS * 1.1));
      }
    }

    expect(salon?.delays).toBeDefined();
    expect(entree?.delays).toBeDefined();
    expect([...(salon?.delays ?? [])].slice(0, 8)).not.toEqual(
      [...(entree?.delays ?? [])].slice(0, 8),
    );
  });

  it('anti-martèlement : une commande repousse le poll suivant d’une période complète', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === CLIM_SALON)).toBe(true);
    });
    const fake = fakeOf(CLIM_SALON);

    const before = fake.calls.getStatus;
    const ack = await send(cmd(CLIM_SALON, { targetTemp: 24 }));
    expect(ack.status).toBe('ok');

    // La resynchronisation vient du setStatus lui-même : la commande ne doit
    // déclencher AUCUN getStatus forcé. Tolérance : au plus un poll régulier
    // peut s'être intercalé pendant l'aller-retour MQTT (course légitime sous
    // charge — la machine de CI peut mettre > POLL_MS à livrer la commande) ;
    // un resync forcé, lui, ajouterait systématiquement un appel de plus.
    expect(fake.calls.getStatus - before).toBeLessThanOrEqual(1);
    expect(fake.calls.setStatus).toBe(1);
  });

  it('verify : dump daté, résumé par unité, aucun secret enregistré', async () => {
    const fixturesDir = join(tmpdir(), `stellar-midea-fixtures-${randomUUID()}`);
    try {
      const summary = await verify({
        units: UNITS,
        fixturesDir,
        logger: logger(),
        createAppliance: (unit: MideaUnit) => {
          const fake = createFakeAppliance({ id: unit.id });
          // Une unité muette doit apparaître comme telle, pas faire échouer verify.
          if (unit.entityId === 'clim_chambre') fake.setUnreachable(true);
          return fake;
        },
      });

      expect(summary.reachable).toBe(2);
      expect(summary.units.map((unit) => unit.entityId)).toEqual([
        CLIM_SALON,
        'clim_entree',
        'clim_chambre',
      ]);
      expect(summary.units[0]).toMatchObject({
        ok: true,
        temperatureId: TEMP_SALON,
        climate: { mode: 'heat', targetTemp: 20.5 },
      });
      expect(summary.units[2]).toMatchObject({ ok: false });
      expect(summary.units[2]?.error).toContain('injoignable');

      // Horodatage aplati : `:` est interdit dans un nom de fichier Windows.
      expect(basename(summary.dumpFile)).toMatch(/^verify-[\d-]+T[\d-]+Z\.json$/);

      const dump = await readFile(summary.dumpFile, 'utf8');
      // Aucun secret : ni la valeur des token/key, ni l'id d'unité (spec §14).
      expect(dump).not.toContain(TOKEN);
      expect(dump).not.toContain(KEY);
      // …et aucune *clé* `token`/`key`/`id` nulle part dans l'arbre. Chercher les
      // valeurs ne suffit pas : un jour un token vaudra « 1 ». On inspecte donc la
      // structure. (Le mot « token » apparaît dans le `_note` du dump, qui explique
      // justement qu'il n'y en a pas — d'où la vérification sur les clés.)
      const keysOf = (value: unknown): string[] =>
        typeof value !== 'object' || value === null
          ? []
          : Array.isArray(value)
            ? value.flatMap(keysOf)
            : Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
      expect(keysOf(JSON.parse(dump))).not.toContain('token');
      expect(keysOf(JSON.parse(dump))).not.toContain('key');
      expect(keysOf(JSON.parse(dump))).not.toContain('id');

      // …mais bien de quoi recaler les fixtures.
      const parsed = JSON.parse(dump) as {
        units: { entityId: string; host: string; status: unknown }[];
      };
      expect(parsed.units).toHaveLength(3);
      expect(parsed.units[0]).toMatchObject({ host: '192.168.5.121' });
      expect(parsed.units[0]?.status).toMatchObject({ powerOn: true, mode: 4 });
      expect(parsed.units[2]?.status).toBeNull();
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

describe('seuil stale', () => {
  it('traduit « injoignable > 5 min » en cycles, avec un plancher de 2', () => {
    // Défauts de prod : 7 cycles × 45 s ≈ 5 min 15 s.
    expect(staleAfterCycles(300_000, 45_000)).toBe(7);
    expect(staleAfterCycles(300_000, 60_000)).toBe(5);
    // Plancher : un échec isolé n'est jamais une panne, même à polling très lent.
    expect(staleAfterCycles(300_000, 300_000)).toBe(2);
    expect(staleAfterCycles(10, 300_000)).toBe(2);
  });
});

describe('manifeste', () => {
  it('déclare deux entités par unité, indépendamment de tout état', () => {
    const manifest = buildManifest([UNITS[0] as MideaUnit]);
    expect(manifest.entities).toEqual([
      { id: CLIM_SALON, kind: 'climate', room: 'salon' },
      { id: TEMP_SALON, kind: 'temperature', room: 'salon', unit: '°C' },
    ]);
  });
});

describe('config', () => {
  it('applique les défauts, sans exiger de variable d’environnement', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      unitsFile: 'config/midea-units.json',
      pollMs: 45_000,
      staleAfterMs: 300_000,
      fixturesDir: 'apps/drivers/midea/__fixtures__',
    });
  });

  it('accepte de resserrer la cadence pour les tests', () => {
    expect(
      loadConfig({
        MIDEA_POLL_MS: '30',
        MIDEA_STALE_AFTER_MS: '150',
        MIDEA_UNITS_FILE: '/tmp/u.json',
      }),
    ).toMatchObject({ pollMs: 30, staleAfterMs: 150, unitsFile: '/tmp/u.json' });
  });

  it('refuse une cadence absurde', () => {
    expect(() => loadConfig({ MIDEA_POLL_MS: '0' })).toThrow(/strictement positive/);
    expect(() => loadConfig({ MIDEA_POLL_MS: 'bientôt' })).toThrow();
  });
});

describe('fichier d’unités', () => {
  const write = async (content: unknown): Promise<string> => {
    const file = join(tmpdir(), `stellar-midea-units-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(content));
    return file;
  };

  it('lit les 3 unités de l’atelier P4.0', async () => {
    const file = await write(UNITS);
    try {
      await expect(loadUnits(file)).resolves.toHaveLength(3);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('refuse un fichier incomplet, dupliqué ou vide plutôt que de démarrer à moitié', async () => {
    const cases: unknown[] = [
      [],
      [{ entityId: 'clim_salon', room: 'salon', host: 'h', id: '1' }],
      [UNITS[0], UNITS[0]],
      [{ ...UNITS[0], inconnu: true }],
      {},
    ];
    for (const content of cases) {
      const file = await write(content);
      try {
        await expect(loadUnits(file)).rejects.toThrow();
      } finally {
        await rm(file, { force: true });
      }
    }
  });

  it('échoue clairement quand le fichier n’existe pas (renvoi vers l’atelier P4.0)', async () => {
    await expect(loadUnits(join(tmpdir(), `absent-${randomUUID()}.json`))).rejects.toThrow();
  });
});
