import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteKeyCode } from '@kud/androidtv-remote';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, type Ack, type Entity, type MediaValue } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { loadConfig } from './config.js';
import { startAndroidTvDriver, type AndroidTvDriverHandle, type TvRemoteLike } from './driver.js';
import { resolveAppLink } from './apps.js';

/** Faux remote : la couture `TvRemoteLike` du driver, sans TLS ni TV. */
class FakeRemote extends EventEmitter implements TvRemoteLike {
  powerCalls = 0;
  keys: Array<{ keyCode: number; direction?: number }> = [];
  appLinks: string[] = [];
  texts: string[] = [];
  sendPower(): void {
    this.powerCalls += 1;
  }
  sendKey(keyCode: number, direction?: number): void {
    this.keys.push({ keyCode, direction });
  }
  sendAppLink(link: string): void {
    this.appLinks.push(link);
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
}

/** Pas de bruit dans la sortie de test — le driver logue sur stdout en prod. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cmd = (action: string, params: Record<string, unknown>, target = 'tv_salon') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('androidtv-driver', () => {
  // Tout est recréé à chaque test : le broker aussi, sinon les messages
  // *retained* d'un test (state, discovery) fuiraient dans le suivant.
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;
  let remote: FakeRemote;
  let handle: AndroidTvDriverHandle;
  let states: Entity[];

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'androidtv', timeoutMs: 2_000 });

  /** Session TV établie — préalable à toute commande depuis l'ADR-009. */
  const connect = (): void => {
    remote.emit('ready');
  };

  const lastMedia = (): { value: MediaValue; stale?: boolean } => {
    const last = states.at(-1);
    if (last === undefined) throw new Error('aucun state publié');
    if (!isKind(last, 'media')) throw new Error(`state publié non-media: ${last.kind}`);
    return { value: last.value, stale: last.stale };
  };

  beforeEach(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: `androidtv-driver-${randomUUID()}`,
      driver: 'androidtv',
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
    remote = new FakeRemote();
    handle = await startAndroidTvDriver({
      bus: driverBus,
      remote,
      entityId: 'tv_salon',
      room: 'salon',
      logger: silentLogger,
    });
    states = [];
    await consumer.onState({ kind: 'media', room: 'salon' }, (entity) => states.push(entity));
  });

  afterEach(async () => {
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('annonce un manifeste discovery retained valide', async () => {
    const raw = await new Promise<string>((resolve) => {
      consumer.client.on('message', (topic, payload) => {
        if (topic === 'home/discovery/androidtv') resolve(payload.toString());
      });
      void consumer.client.subscribeAsync('home/discovery/androidtv', { qos: 1 });
    });
    const manifest = Manifest.parse(JSON.parse(raw));
    expect(manifest.entities[0]).toEqual({ id: 'tv_salon', kind: 'media', room: 'salon' });
    expect(manifest.commands.map((c) => c.action)).toContain('launch_app');
  });

  it('publie l’entité media dès l’établissement de la session', async () => {
    expect(states).toHaveLength(0);
    connect();
    await vi.waitFor(() => {
      expect(lastMedia()).toEqual({ value: { power: false }, stale: undefined });
    });
  });

  it('DoD P1 : « lance Netflix » réveille la TV et ouvre l’app', async () => {
    connect(); // état initial : TV éteinte (power=false)
    const ack = await send(cmd('launch_app', { app: 'netflix' }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(1); // TV réveillée
    expect(remote.appLinks).toEqual(['https://www.netflix.com/title']);
  });

  it('les événements du protocole alimentent le percept media', async () => {
    connect();
    remote.emit('powered', true);
    remote.emit('current_app', 'com.netflix.ninja');
    remote.emit('volume', { level: 5, maximum: 10, muted: false });

    await vi.waitFor(() => {
      expect(lastMedia().value).toEqual({
        power: true,
        currentApp: 'com.netflix.ninja',
        volume: 50,
      });
    });
  });

  it('power {on:true} sur TV déjà allumée = aucun toggle superflu', async () => {
    connect();
    remote.emit('powered', true);
    const ack = await send(cmd('power', { on: true }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(0);
  });

  it('power {on:false} sur TV allumée = un toggle', async () => {
    connect();
    remote.emit('powered', true);
    const ack = await send(cmd('power', { on: false }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(1);
  });

  it('traduit key et volume en keycodes', async () => {
    connect();
    await send(cmd('key', { key: 'KEYCODE_HOME' }));
    await send(cmd('volume', { direction: 'up' }));
    expect(remote.keys.map((k) => k.keyCode)).toEqual([
      RemoteKeyCode['KEYCODE_HOME'],
      RemoteKeyCode['KEYCODE_VOLUME_UP'],
    ]);
  });

  it('transmet send_text tel quel', async () => {
    connect();
    const ack = await send(cmd('send_text', { text: 'stellar 42' }));
    expect(ack.status).toBe('ok');
    expect(remote.texts).toEqual(['stellar 42']);
  });

  it('rejette app inconnue, keycode inconnu, action inconnue, mauvaise cible', async () => {
    connect();
    expect((await send(cmd('launch_app', { app: 'canal_plus_atlantis' }))).status).toBe('rejected');
    expect((await send(cmd('key', { key: 'KEYCODE_INEXISTANT' }))).status).toBe('rejected');
    expect((await send(cmd('teleporter', {}))).status).toBe('rejected');
    expect((await send(cmd('power', {}, 'tv_cuisine'))).status).toBe('rejected');
  });

  it('rejette toute commande tant que la session n’est pas établie (ADR-009)', async () => {
    expect(handle.connected).toBe(false);
    const ack = await send(cmd('key', { key: 'KEYCODE_HOME' }));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('injoignable');
    expect(remote.keys).toEqual([]); // rien n'a été tenté dans le vide
  });

  it('rejette les commandes après la perte de session (jamais d’ack ok muet)', async () => {
    connect();
    remote.emit('error', new Error('ECONNRESET'));
    expect(handle.connected).toBe(false);

    const ack = await send(cmd('power', { on: true }));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('injoignable');
    expect(remote.powerCalls).toBe(0);
  });

  it('perte de session : l’entité est republiée stale (ADR-009)', async () => {
    connect();
    remote.emit('powered', true);
    await vi.waitFor(() => {
      expect(lastMedia().value.power).toBe(true);
    });

    remote.emit('unpaired'); // un simple ECONNRESET suffit à déclencher cet event
    await vi.waitFor(() => {
      expect(lastMedia()).toEqual({ value: { power: true }, stale: true });
    });
  });

  it('retour de la session : l’entité est republiée sans stale', async () => {
    connect();
    remote.emit('powered', true);
    remote.emit('error', new Error('boom'));
    await vi.waitFor(() => {
      expect(lastMedia().stale).toBe(true);
    });

    connect();
    await vi.waitFor(() => {
      expect(lastMedia()).toEqual({ value: { power: true }, stale: undefined });
    });
    expect(handle.connected).toBe(true);
  });
});

describe('apps', () => {
  it('résout les noms connus et laisse passer les deep links', () => {
    expect(resolveAppLink('Netflix')).toBe('https://www.netflix.com/title');
    expect(resolveAppLink('prime video')).toBe('https://app.primevideo.com');
    expect(resolveAppLink('vnd.youtube://watch?v=x')).toBe('vnd.youtube://watch?v=x');
    expect(resolveAppLink('appli_mystere')).toBeUndefined();
  });
});

describe('config', () => {
  it('applique les défauts et n’exige que ATV_HOST', () => {
    expect(loadConfig({ ATV_HOST: '192.168.1.42' })).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      tvHost: '192.168.1.42',
      entityId: 'tv_salon',
      room: 'salon',
      certFile: 'config/androidtv-cert.json',
    });
  });

  it('surcharge chaque valeur par son variable d’environnement', () => {
    expect(
      loadConfig({
        STELLAR_MQTT_URL: 'mqtt://broker:1883',
        ATV_HOST: '10.0.0.5',
        ATV_ENTITY_ID: 'tv_chambre',
        ATV_ROOM: 'chambre',
        ATV_CERT_FILE: '/secrets/atv.json',
      }).entityId,
    ).toBe('tv_chambre');
  });

  it('échoue clairement si ATV_HOST manque', () => {
    expect(() => loadConfig({})).toThrow(/ATV_HOST requis/);
  });
});
