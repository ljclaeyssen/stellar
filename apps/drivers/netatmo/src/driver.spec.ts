import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, valueOf, type Ack, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { startSimNetatmo, type SimNetatmo } from '@stellar/sim-netatmo';
import { createNetatmoApi, type NetatmoApiLike } from './api.js';
import { createTokenStore, type TokenStore } from './auth.js';
import { loadConfig } from './config.js';
import { startNetatmoDriver, type NetatmoDriverHandle } from './driver.js';
import { verify } from './verify.js';

const THERMOSTAT = 'thermostat_maison';
const TEMP_SALON = 'temp_salon';
const TEMP_EXT = 'temp_exterieur';
const WEATHER = 'weather_maison';
const ALL_ENTITIES = [
  THERMOSTAT,
  TEMP_SALON,
  'humidity_salon',
  TEMP_EXT,
  'humidity_exterieur',
  WEATHER,
];

const cmd = (target: string, params: Record<string, unknown>, action = 'set') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('netatmo-driver contre le simulateur', () => {
  // Broker, simulateur ET fichier de tokens recréés à chaque test : sinon les
  // messages *retained* et la rotation des tokens fuiraient d'un test à l'autre.
  let broker: TestBroker;
  let sim: SimNetatmo;
  let tokenFile: string;
  let tokens: TokenStore;
  let api: NetatmoApiLike;
  let driverBus: Bus;
  let consumer: Bus;
  let handle: NetatmoDriverHandle;
  let states: Entity[];
  let errors: string[];

  const logger = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg) => errors.push(msg),
  });

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'netatmo', timeoutMs: 3_000 });

  const latest = (id: string): Entity => {
    const found = states.filter((entity) => entity.id === id).at(-1);
    if (found === undefined) throw new Error(`aucun state publié pour ${id}`);
    return found;
  };

  beforeEach(async () => {
    errors = [];
    broker = await startTestBroker();
    sim = await startSimNetatmo();
    tokenFile = join(tmpdir(), `stellar-netatmo-token-${randomUUID()}.json`);
    await writeFile(tokenFile, `${JSON.stringify({ refreshToken: sim.state.refreshToken })}\n`);

    driverBus = await createBus({
      url: broker.url,
      clientId: `netatmo-driver-${randomUUID()}`,
      driver: 'netatmo',
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
    await consumer.onState({ driver: 'netatmo' }, (entity) => states.push(entity));

    tokens = createTokenStore({
      apiUrl: sim.url,
      clientId: sim.clientId,
      clientSecret: sim.clientSecret,
      tokenFile,
      logger: logger(),
      expirySkewMs: 0,
      requestTimeoutMs: 2_000,
      authRetryMs: 25,
    });
    api = createNetatmoApi({ baseUrl: sim.url, tokens, logger: logger(), requestTimeoutMs: 2_000 });
    handle = await startNetatmoDriver({
      bus: driverBus,
      api,
      logger: logger(),
      // Cadences resserrées : on teste la *logique* de polling, pas la patience.
      thermostatIntervalMs: 50,
      // La station ne doit pas consommer les échecs simulés du test `failNext`.
      stationIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    handle.close();
    await consumer.close();
    await driverBus.close();
    await sim.close();
    await broker.close();
    await rm(tokenFile, { force: true });
  });

  it('publie thermostat et station en entités retained conformes au contrat', async () => {
    await vi.waitFor(() => {
      expect([...new Set(states.map((entity) => entity.id))].sort()).toEqual(
        [...ALL_ENTITIES].sort(),
      );
    });

    const thermostat = latest(THERMOSTAT);
    expect(isKind(thermostat, 'climate')).toBe(true);
    expect(thermostat.room).toBe('maison');
    expect(thermostat.value).toEqual({
      power: true,
      mode: 'auto',
      targetTemp: 19,
      indoorTemp: 19.4,
      fan: 'none',
    });
    expect(thermostat.stale).toBeUndefined();

    expect(isKind(latest(TEMP_SALON), 'temperature')).toBe(true);
    expect(latest(TEMP_SALON)).toMatchObject({ value: 20.8, unit: '°C', room: 'salon' });
    expect(latest(TEMP_EXT)).toMatchObject({ value: 8.3, room: 'exterieur' });
    expect(isKind(latest('humidity_salon'), 'humidity')).toBe(true);
    expect(isKind(latest(WEATHER), 'weather')).toBe(true);
    expect(latest(WEATHER).value).toMatchObject({ pressure: 1014.2, co2: 638, tempOut: 8.3 });

    // Retained : un abonné arrivé *après* le démarrage reçoit tout l'inventaire.
    const late = await createBus({
      url: broker.url,
      clientId: `late-${randomUUID()}`,
      driver: 'late',
      protocolVersion: 4,
      logger: logger(),
    });
    const seen = new Set<string>();
    await late.onState({ driver: 'netatmo' }, (entity) => seen.add(entity.id));
    await vi.waitFor(() => {
      expect(seen.size).toBe(ALL_ENTITIES.length);
    });
    await late.close();
  });

  it('annonce un manifeste discovery retained valide', async () => {
    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/netatmo' && payload.length > 0) {
          const manifest = JSON.parse(payload.toString()) as Manifest;
          if (manifest.entities.length > 0) resolve(payload.toString());
        }
      });
      void consumer.client.subscribeAsync('home/discovery/netatmo', { qos: 1 });
    });
    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.driver).toBe('netatmo');
    expect(manifest.entities).toContainEqual({ id: THERMOSTAT, kind: 'climate', room: 'maison' });
    expect(manifest.entities).toContainEqual({
      id: TEMP_SALON,
      kind: 'temperature',
      room: 'salon',
      unit: '°C',
    });
    expect(manifest.commands.map((command) => command.action)).toEqual(['set']);
    expect(manifest.commands[0]?.paramsSchema).toHaveProperty('properties');
  });

  it('le polling suit l’état réel : une T° changée côté Netatmo remonte sur le bus', async () => {
    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')?.indoorTemp).toBe(19.4);
    });
    sim.setRoomTemp(21.3);
    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')?.indoorTemp).toBe(21.3);
    });
  });

  it('DoD P3 : set targetTemp → consigne appliquée côté Netatmo, ack ok, état frais', async () => {
    const ack = await send(cmd(THERMOSTAT, { targetTemp: 21 }));
    expect(ack.status).toBe('ok');

    const room = (sim.state.homeStatus['rooms'] as Array<Record<string, unknown>>)[0];
    expect(room).toMatchObject({ therm_setpoint_temperature: 21, therm_setpoint_mode: 'manual' });

    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')).toMatchObject({
        targetTemp: 21,
        mode: 'heat',
        power: true,
      });
    });
  });

  it('set mode auto → retour au programme (setthermmode)', async () => {
    expect((await send(cmd(THERMOSTAT, { targetTemp: 22 }))).status).toBe('ok');
    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')?.mode).toBe('heat');
    });

    const ack = await send(cmd(THERMOSTAT, { mode: 'auto' }));
    expect(ack.status).toBe('ok');
    expect((sim.state.homesData['homes'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      therm_mode: 'schedule',
    });
    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')?.mode).toBe('auto');
    });
  });

  it('set mode heat sans température reprend la consigne courante', async () => {
    const ack = await send(cmd(THERMOSTAT, { mode: 'heat' }));
    expect(ack.status).toBe('ok');
    const room = (sim.state.homeStatus['rooms'] as Array<Record<string, unknown>>)[0];
    expect(room).toMatchObject({ therm_setpoint_mode: 'manual', therm_setpoint_temperature: 19 });
  });

  it('rejette les params invalides sans rien envoyer à Netatmo', async () => {
    expect((await send(cmd(THERMOSTAT, {}))).status).toBe('rejected');
    expect((await send(cmd(THERMOSTAT, { targetTemp: 45 }))).status).toBe('rejected');
    expect((await send(cmd(THERMOSTAT, { targetTemp: 4 }))).status).toBe('rejected');
    expect((await send(cmd(THERMOSTAT, { mode: 'cool' }))).status).toBe('rejected');
    expect((await send(cmd(THERMOSTAT, { power: true }))).status).toBe('rejected');
    expect((await send(cmd(THERMOSTAT, { targetTemp: 20 }, 'toggle'))).status).toBe('rejected');

    // `auto` + consigne : contradictoire, le programme écraserait la consigne.
    const contradictoire = await send(cmd(THERMOSTAT, { mode: 'auto', targetTemp: 20 }));
    expect(contradictoire.status).toBe('rejected');
    expect(contradictoire.reason).toContain('contradictoires');

    const inconnue = await send(cmd('thermostat_cave', { targetTemp: 20 }));
    expect(inconnue.status).toBe('rejected');
    expect(inconnue.reason).toContain('entité inconnue');

    const room = (sim.state.homeStatus['rooms'] as Array<Record<string, unknown>>)[0];
    expect(room).toMatchObject({ therm_setpoint_mode: 'schedule' });
  });

  it('access token expiré en cours de route : rafraîchissement transparent', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === THERMOSTAT)).toBe(true);
    });
    const refreshesBefore = sim.refreshCount;

    sim.expireAccessToken();
    sim.setRoomTemp(18.2);

    await vi.waitFor(() => {
      expect(valueOf(latest(THERMOSTAT), 'climate')?.indoorTemp).toBe(18.2);
    });
    expect(sim.refreshCount).toBeGreaterThan(refreshesBefore);
    expect(latest(THERMOSTAT).stale).toBeUndefined();
    expect(handle.authDead).toBe(false);
    // La rotation a bien été persistée au passage.
    const persisted = JSON.parse(await readFile(tokenFile, 'utf8')) as { refreshToken: string };
    expect(persisted.refreshToken).toBe(sim.state.refreshToken);
  });

  it('refresh révoqué : entités stale, commande rejetée, log d’action humaine (ADR-009)', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === THERMOSTAT)).toBe(true);
    });

    sim.revokeRefreshToken();
    sim.expireAccessToken();

    await vi.waitFor(() => {
      expect(handle.authDead).toBe(true);
      expect(latest(THERMOSTAT).stale).toBe(true);
    });
    expect(handle.reachable).toBe(false);

    const ack = await send(cmd(THERMOSTAT, { targetTemp: 20 }));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('réauthentification manuelle requise');
    expect(errors.some((msg) => msg.includes('réauthentification manuelle requise'))).toBe(true);

    // L'humain régénère un refresh token et réécrit le fichier → reprise seule.
    sim.state.refreshTokenRevoked = false;
    await writeFile(tokenFile, `${JSON.stringify({ refreshToken: sim.state.refreshToken })}\n`);
    await vi.waitFor(
      () => {
        expect(handle.authDead).toBe(false);
        expect(latest(THERMOSTAT).stale).toBeUndefined();
      },
      { timeout: 5_000 },
    );
  });

  it('API muette 2 cycles : entités stale, puis fraîches au retour (ADR-009)', async () => {
    await vi.waitFor(() => {
      expect(states.some((entity) => entity.id === THERMOSTAT)).toBe(true);
    });

    sim.failNext(2);
    await vi.waitFor(
      () => {
        expect(latest(THERMOSTAT).stale).toBe(true);
      },
      { timeout: 5_000 },
    );
    // Une panne réseau n'est pas une panne d'authentification.
    expect(handle.authDead).toBe(false);

    await vi.waitFor(
      () => {
        expect(latest(THERMOSTAT).stale).toBeUndefined();
      },
      { timeout: 5_000 },
    );
    expect(handle.reachable).toBe(true);
  });

  it('verify : dump de fixtures daté + résumé, en lecture seule', async () => {
    const fixturesDir = join(tmpdir(), `stellar-netatmo-fixtures-${randomUUID()}`);
    try {
      const summary = await verify({ api, apiUrl: sim.url, fixturesDir, logger: logger() });

      expect(summary).toMatchObject({
        home: 'Maison',
        thermostats: [THERMOSTAT],
        stations: ['Maison'],
      });
      expect(summary.entityIds.sort()).toEqual([...ALL_ENTITIES].sort());
      // Horodatage aplati : `:` est interdit dans un nom de fichier Windows.
      expect(basename(summary.dumpFile)).toMatch(/^verify-[\d-]+T[\d-]+Z\.json$/);

      const dump = JSON.parse(await readFile(summary.dumpFile, 'utf8')) as {
        responses: { homesdata: unknown[]; homestatus: unknown; getstationsdata: unknown[] };
      };
      expect(dump.responses.homesdata).toHaveLength(1);
      expect(dump.responses.getstationsdata).toHaveLength(1);
      expect(dump.responses.homestatus).toMatchObject({ id: '5f8a1b2c3d4e5f6a7b8c9d0e' });
      // Lecture seule : la consigne n'a pas bougé.
      const room = (sim.state.homeStatus['rooms'] as Array<Record<string, unknown>>)[0];
      expect(room).toMatchObject({ therm_setpoint_mode: 'schedule' });
      // Aucun secret dans le dump.
      expect(await readFile(summary.dumpFile, 'utf8')).not.toContain('refresh-');
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

describe('config', () => {
  const minimal = { NETATMO_CLIENT_ID: 'id', NETATMO_CLIENT_SECRET: 'secret' };

  it('applique les défauts et n’exige que les identifiants de l’app OAuth', () => {
    expect(loadConfig(minimal)).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      apiUrl: 'https://api.netatmo.com',
      clientId: 'id',
      clientSecret: 'secret',
      tokenFile: 'config/netatmo-token.json',
      thermostatIntervalMs: 90_000,
      stationIntervalMs: 300_000,
      authRetryMs: 900_000,
      fixturesDir: 'apps/drivers/netatmo/__fixtures__',
    });
  });

  it('échoue clairement sans client id/secret', () => {
    expect(() => loadConfig({})).toThrow(/NETATMO_CLIENT_ID requis/);
    expect(() => loadConfig({ NETATMO_CLIENT_ID: 'id' })).toThrow(/NETATMO_CLIENT_SECRET requis/);
  });

  it('accepte de viser le simulateur et de resserrer les cadences', () => {
    const config = loadConfig({
      ...minimal,
      NETATMO_API_URL: 'http://127.0.0.1:8843',
      NETATMO_THERMOSTAT_INTERVAL_MS: '250',
      NETATMO_STATION_INTERVAL_MS: '500',
    });
    expect(config).toMatchObject({
      apiUrl: 'http://127.0.0.1:8843',
      thermostatIntervalMs: 250,
      stationIntervalMs: 500,
    });
  });

  it('refuse une URL d’API qui n’en est pas une', () => {
    expect(() => loadConfig({ ...minimal, NETATMO_API_URL: 'api.netatmo.com' })).toThrow(/http/);
  });
});
