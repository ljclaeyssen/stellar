import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteKeyCode } from '@kud/androidtv-remote';
import { createBus, createLogger, type Bus } from '@stellar/bus';
import { Manifest, type Ack, type Entity, type MediaValue } from '@stellar/contracts';
import { startAndroidTvDriver, type TvRemoteLike } from './driver.js';
import { resolveAppLink } from './apps.js';
import { startTestBroker, type TestBroker } from './test-broker.js';

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

const cmd = (action: string, params: Record<string, unknown>, target = 'tv_salon') => ({
  id: randomUUID(),
  target,
  action,
  params,
  issuedBy: 'cli' as const,
  ts: new Date().toISOString(),
});

describe('androidtv-driver', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let consumer: Bus;
  let remote: FakeRemote;

  const send = (c: ReturnType<typeof cmd>): Promise<Ack> =>
    consumer.sendCommand(c, { driver: 'androidtv', timeoutMs: 2_000 });

  beforeAll(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: 'androidtv-driver',
      driver: 'androidtv',
      protocolVersion: 4,
    });
    consumer = await createBus({
      url: broker.url,
      clientId: 'test-consumer',
      driver: 'consumer',
      protocolVersion: 4,
    });
    remote = new FakeRemote();
    await startAndroidTvDriver({
      bus: driverBus,
      remote,
      entityId: 'tv_salon',
      room: 'salon',
      logger: createLogger('androidtv-test'),
    });
  });

  afterAll(async () => {
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

  it('DoD P1 : « lance Netflix » réveille la TV et ouvre l’app', async () => {
    // état initial : TV éteinte (power=false)
    const ack = await send(cmd('launch_app', { app: 'netflix' }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(1); // TV réveillée
    expect(remote.appLinks).toEqual(['https://www.netflix.com/title']);
  });

  it('les événements du protocole alimentent le percept media', async () => {
    const states: Entity[] = [];
    await consumer.onState({ kind: 'media', room: 'salon' }, (entity) => states.push(entity));

    remote.emit('powered', true);
    remote.emit('current_app', 'com.netflix.ninja');
    remote.emit('volume', { level: 5, maximum: 10, muted: false });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        const last = states.at(-1)?.value as MediaValue | undefined;
        if (last?.volume === 50 && last.currentApp === 'com.netflix.ninja' && last.power) resolve();
        else setTimeout(check, 20);
      };
      check();
    });
    const value = states.at(-1)?.value as MediaValue;
    expect(value).toEqual({ power: true, currentApp: 'com.netflix.ninja', volume: 50 });
  });

  it('power {on:true} sur TV déjà allumée = aucun toggle superflu', async () => {
    const before = remote.powerCalls;
    const ack = await send(cmd('power', { on: true }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(before); // déjà allumée (événement précédent)
  });

  it('power {on:false} sur TV allumée = un toggle', async () => {
    const before = remote.powerCalls;
    const ack = await send(cmd('power', { on: false }));
    expect(ack.status).toBe('ok');
    expect(remote.powerCalls).toBe(before + 1);
  });

  it('traduit key et volume en keycodes', async () => {
    await send(cmd('key', { key: 'KEYCODE_HOME' }));
    await send(cmd('volume', { direction: 'up' }));
    expect(remote.keys.map((k) => k.keyCode)).toEqual([
      RemoteKeyCode['KEYCODE_HOME'],
      RemoteKeyCode['KEYCODE_VOLUME_UP'],
    ]);
  });

  it('rejette app inconnue, keycode inconnu, action inconnue, mauvaise cible', async () => {
    expect((await send(cmd('launch_app', { app: 'canal_plus_atlantis' }))).status).toBe('rejected');
    expect((await send(cmd('key', { key: 'KEYCODE_INEXISTANT' }))).status).toBe('rejected');
    expect((await send(cmd('teleporter', {}))).status).toBe('rejected');
    expect((await send(cmd('power', {}, 'tv_cuisine'))).status).toBe('rejected');
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
