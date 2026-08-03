import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, valueOf, type Ack, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { startSimHue, type SimHue } from '@stellar/sim-hue';
import { createHueApi, type HueApiLike } from './api.js';
import { AppKeyFile, loadConfig } from './config.js';
import { startHueDriver, toLightPatch, type HueDriverHandle } from './driver.js';
import { pair } from './pair.js';
import { verify } from './verify.js';

/** Pas de bruit dans la sortie de test — le driver logue sur stdout en prod. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const CANAPE = 'light_salon_canape';
const CHEVET = 'light_chambre_chevet';
const PRISE = 'plug_prise_tv';
/** id de ressource CLIP v2 de la lampe « Canapé » (fixtures). */
const CANAPE_LIGHT_ID = '1f7a2b3c-4d5e-4f60-8a91-b2c3d4e5f601';

const cmd = (target: string, params: Record<string, unknown>, action = 'set') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('hue-driver contre le simulateur CLIP v2', () => {
  // Broker ET simulateur recréés à chaque test : sinon les messages *retained*
  // (state, discovery) et l'état des lampes fuiraient d'un test à l'autre.
  let broker: TestBroker;
  let sim: SimHue;
  let api: HueApiLike;
  let driverBus: Bus;
  let consumer: Bus;
  let handle: HueDriverHandle;
  let states: Entity[];

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'hue', timeoutMs: 3_000 });

  const latest = (id: string): Entity => {
    const found = states.filter((entity) => entity.id === id).at(-1);
    if (found === undefined) throw new Error(`aucun state publié pour ${id}`);
    return found;
  };

  beforeEach(async () => {
    broker = await startTestBroker();
    sim = await startSimHue();
    driverBus = await createBus({
      url: broker.url,
      clientId: `hue-driver-${randomUUID()}`,
      driver: 'hue',
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
    await consumer.onState({ driver: 'hue' }, (entity) => states.push(entity));

    api = createHueApi({
      baseUrl: sim.url,
      applicationKey: sim.applicationKey,
      logger: silentLogger,
      // Backoff resserré : on teste la *logique* down/up, pas la patience.
      reconnectMinMs: 25,
      reconnectMaxMs: 200,
      requestTimeoutMs: 2_000,
    });
    handle = await startHueDriver({ bus: driverBus, api, logger: silentLogger });
    await vi.waitFor(() => {
      expect(sim.eventClients).toBe(1);
    });
  });

  afterEach(async () => {
    handle.close();
    await consumer.close();
    await driverBus.close();
    await sim.close();
    await broker.close();
  });

  it('publie l’inventaire complet en entités retained conformes au contrat', async () => {
    await vi.waitFor(() => {
      expect(states.map((entity) => entity.id).sort()).toEqual([CHEVET, CANAPE, PRISE].sort());
    });

    const canape = latest(CANAPE);
    expect(isKind(canape, 'light')).toBe(true);
    expect(canape.room).toBe('salon');
    expect(canape.value).toEqual({
      on: false,
      brightness: 62.4,
      color: { xy: { x: 0.4573, y: 0.41 }, mirek: 366 },
    });

    // La « Prise TV » sort en kind plug, sans préfixe de pièce (spec §6).
    const prise = latest(PRISE);
    expect(isKind(prise, 'plug')).toBe(true);
    expect(prise.room).toBe('salon');
    expect(prise.value).toEqual({ on: true });
    expect(prise.stale).toBeUndefined();

    // Retained : un abonné arrivé *après* le démarrage reçoit tout l'inventaire.
    const late = await createBus({
      url: broker.url,
      clientId: `late-${randomUUID()}`,
      driver: 'late',
      protocolVersion: 4,
      logger: silentLogger,
    });
    const seen: Entity[] = [];
    await late.onState({ driver: 'hue' }, (entity) => seen.push(entity));
    await vi.waitFor(() => {
      expect(seen).toHaveLength(3);
    });
    await late.close();
  });

  it('annonce un manifeste discovery retained valide', async () => {
    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/hue') resolve(payload.toString());
      });
      void consumer.client.subscribeAsync('home/discovery/hue', { qos: 1 });
    });
    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.driver).toBe('hue');
    expect(manifest.entities).toContainEqual({ id: PRISE, kind: 'plug', room: 'salon' });
    expect(manifest.entities).toContainEqual({ id: CANAPE, kind: 'light', room: 'salon' });
    expect(manifest.commands.map((c) => c.action)).toEqual(['set']);
    expect(manifest.commands[0]?.paramsSchema).toHaveProperty('properties');
  });

  it('DoD P2 : set {on:true} → ack ok en moins de 300 ms, puis state frais via SSE', async () => {
    const started = performance.now();
    const ack = await send(cmd(CANAPE, { on: true }));
    const elapsedMs = performance.now() - started;

    expect(ack.status).toBe('ok');
    expect(elapsedMs).toBeLessThan(300);

    await vi.waitFor(() => {
      expect(valueOf(latest(CANAPE), 'light')?.on).toBe(true);
    });
    // …et l'état publié reflète le bridge, pas un optimisme du driver.
    expect(latest(CANAPE).stale).toBeUndefined();
  });

  it('traduit brightness et mirek en PUT CLIP v2', async () => {
    expect(toLightPatch({ brightness: 40, color: { mirek: 250 } })).toEqual({
      dimming: { brightness: 40 },
      color_temperature: { mirek: 250 },
    });

    const ack = await send(cmd(CHEVET, { brightness: 40, color: { mirek: 250 } }));
    expect(ack.status).toBe('ok');
    await vi.waitFor(() => {
      expect(valueOf(latest(CHEVET), 'light')).toEqual({
        on: false,
        brightness: 40,
        color: { mirek: 250 },
      });
    });
  });

  it('propage un changement venu du bridge (bouton mural) sans commande', async () => {
    sim.setLight(CANAPE_LIGHT_ID, { on: { on: true }, dimming: { brightness: 12 } });
    await vi.waitFor(() => {
      expect(valueOf(latest(CANAPE), 'light')).toMatchObject({ on: true, brightness: 12 });
    });
  });

  it('rejette les params invalides sans rien envoyer au bridge', async () => {
    expect((await send(cmd(CANAPE, { brightness: 250 }))).status).toBe('rejected');
    expect((await send(cmd(CANAPE, {}))).status).toBe('rejected');
    expect((await send(cmd(CANAPE, { on: 'oui' }))).status).toBe('rejected');
    expect((await send(cmd(CANAPE, { power: true }))).status).toBe('rejected');
    expect((await send(cmd(CANAPE, { color: {} }))).status).toBe('rejected');
    expect((await send(cmd(CANAPE, { on: true }, 'toggle'))).status).toBe('rejected');
    // Une prise ne sait que s'allumer.
    expect((await send(cmd(PRISE, { brightness: 50 }))).status).toBe('rejected');

    expect(valueOf(latest(CANAPE), 'light')?.on).toBe(false);
  });

  it('rejette une entité inconnue', async () => {
    const ack = await send(cmd('light_cave_etabli', { on: true }));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('entité inconnue');
  });

  it('bridge muet : entités stale et commandes rejetées, puis resync au retour (ADR-009)', async () => {
    const port = sim.port;
    await sim.close();

    await vi.waitFor(
      () => {
        expect(handle.reachable).toBe(false);
      },
      { timeout: 5_000 },
    );

    const rejected = await send(cmd(PRISE, { on: false }));
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toContain('injoignable');

    await vi.waitFor(() => {
      expect(latest(PRISE).stale).toBe(true);
      expect(latest(CANAPE).stale).toBe(true);
    });

    // Même port : le driver doit se rebrancher seul et **ré-inventorier**.
    sim = await startSimHue({ port });
    await vi.waitFor(
      () => {
        expect(handle.reachable).toBe(true);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => {
      expect(latest(PRISE).stale).toBeUndefined();
      expect(latest(CANAPE).stale).toBeUndefined();
    });

    const ack = await send(cmd(PRISE, { on: false }));
    expect(ack.status).toBe('ok');
    await vi.waitFor(() => {
      expect(valueOf(latest(PRISE), 'plug')?.on).toBe(false);
    });
  });

  it('pairing : erreur 101 tant que le bouton n’est pas pressé, puis key persistée', async () => {
    const keyFile = join(tmpdir(), `stellar-hue-key-${randomUUID()}.json`);
    const infos: string[] = [];
    const capturing: Logger = { ...silentLogger, info: (msg) => infos.push(msg) };

    const pairing = pair(sim.url, keyFile, capturing, { intervalMs: 25, timeoutMs: 5_000 });
    // Le bridge répond 101 en boucle : c'est ce message-là qui le prouve.
    await vi.waitFor(() => {
      expect(infos.some((msg) => msg.includes('attend'))).toBe(true);
    });

    sim.pressLinkButton();
    const result = await pairing;
    expect(result.applicationKey).toBe(sim.applicationKey);

    const persisted = AppKeyFile.parse(JSON.parse(await readFile(keyFile, 'utf8')));
    expect(persisted).toEqual({ applicationKey: sim.applicationKey, clientKey: sim.clientKey });
    await rm(keyFile, { force: true });
  });

  it('verify : dump de fixtures daté + résumé de l’inventaire', async () => {
    const fixturesDir = join(tmpdir(), `stellar-hue-fixtures-${randomUUID()}`);
    try {
      const summary = await verify({
        api,
        bridgeUrl: sim.url,
        fixturesDir,
        logger: silentLogger,
      });

      expect(summary).toMatchObject({ lights: 2, plugs: 1, rooms: ['Chambre', 'Salon'] });
      expect(summary.entityIds.sort()).toEqual([CHEVET, CANAPE, PRISE].sort());
      // Horodatage aplati : `:` est interdit dans un nom de fichier Windows.
      expect(basename(summary.dumpFile)).toMatch(/^verify-[\d-]+T[\d-]+Z\.json$/);

      const dump: unknown = JSON.parse(await readFile(summary.dumpFile, 'utf8'));
      const parsed = dump as {
        resources: { light: unknown[]; device: unknown[]; room: unknown[] };
      };
      expect(parsed.resources.light).toHaveLength(3);
      expect(parsed.resources.device).toHaveLength(3);
      expect(parsed.resources.room).toHaveLength(2);
    } finally {
      await rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

describe('config', () => {
  it('applique les défauts et n’exige que HUE_BRIDGE_URL', () => {
    expect(loadConfig({ HUE_BRIDGE_URL: 'https://192.168.1.10' })).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      bridgeUrl: 'https://192.168.1.10',
      appKeyFile: 'config/hue-app-key.json',
      fixturesDir: 'apps/drivers/hue/__fixtures__',
    });
  });

  it('échoue clairement si HUE_BRIDGE_URL manque ou n’est pas une URL http(s)', () => {
    expect(() => loadConfig({})).toThrow(/HUE_BRIDGE_URL requis/);
    expect(() => loadConfig({ HUE_BRIDGE_URL: '192.168.1.10' })).toThrow(/http/);
  });

  it('accepte l’application key par l’environnement', () => {
    expect(loadConfig({ HUE_BRIDGE_URL: 'http://localhost:8842', HUE_APP_KEY: 'abc' }).appKey).toBe(
      'abc',
    );
  });
});
