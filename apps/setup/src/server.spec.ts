import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovalRegistry, type ApprovalRegistry } from './approvals.js';
import { createEventStream } from './events.js';
import { createSetupServer, isLoopbackHost, type SetupServer } from './server.js';
import type { SetupSession } from './session.js';
import { silentLogger } from './testing.js';

/**
 * La prise HTTP de l'IHM — **sans clé d'API et sans session** pour l'essentiel.
 *
 * Ce que ces cas protègent : la page se sert vraiment (c'est la seule chose que
 * l'humain verra), le bandeau répond, une IHM lancée sans session le dit
 * clairement au lieu d'avaler le message, et une décision d'approbation qui
 * arrive trop tard n'a aucun effet.
 */

let running: SetupServer | undefined;

interface Booted {
  base: string;
  approvals: ApprovalRegistry;
}

async function boot(options: { session?: SetupSession } = {}): Promise<Booted> {
  const { logger } = silentLogger();
  const stream = createEventStream({ pending: () => approvals.pending() });
  const approvals = createApprovalRegistry({ emit: stream.emit, logger });
  const server = createSetupServer({
    logger,
    stream,
    approvals,
    ...(options.session !== undefined ? { session: options.session } : {}),
    status: () =>
      Promise.resolve({
        broker: false,
        coreApi: false,
        env: true,
        ports: { broker: 1883, coreApi: 8850 },
      }),
  });
  const port = await server.listen(0, '127.0.0.1');
  running = server;
  return { base: `http://127.0.0.1:${port}`, approvals };
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** `fetch` refuse de poser un en-tête `Host` : ce cas passe par `node:http`. */
function rawGet(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('prise HTTP de l’IHM de setup', () => {
  it('sert la page de chat sur GET /', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Stellar');
    // Ce qui fait l'IHM : le flux d'événements et la carte d'approbation.
    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain('Autoriser');
    // Zéro CDN : la page doit être autoportante (la machine n'a peut-être pas
    // encore de réseau configuré).
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it('répond les trois voyants sur GET /status', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      broker: false,
      coreApi: false,
      env: true,
      ports: { broker: 1883, coreApi: 8850 },
    });
  });

  it('refuse proprement POST /message quand aucune session n’existe', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bonjour' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ANTHROPIC_API_KEY');
  });

  it('rejette un message vide ou mal formé', async () => {
    const sent: string[] = [];
    const session: SetupSession = {
      send: (text) => sent.push(text),
      busy: () => false,
      close: () => undefined,
    };
    const { base } = await boot({ session });

    for (const body of [{}, { text: '   ' }, { text: 'ok', extra: 1 }]) {
      const res = await fetch(`${base}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it('refuse un second tour tant que le premier n’est pas fini', async () => {
    const session: SetupSession = {
      send: () => undefined,
      busy: () => true,
      close: () => undefined,
    };
    const { base } = await boot({ session });

    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'et aussi…' }),
    });
    expect(res.status).toBe(409);
  });

  it('ne ré-autorise pas une demande d’approbation déjà tranchée', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'inexistant', allow: true }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ resolved: false });
  });

  it('refuse les requêtes dont l’Host n’est pas loopback (DNS rebinding)', async () => {
    const { base } = await boot();
    const port = Number(new URL(base).port);

    await expect(rawGet(port, 'attaquant.example')).resolves.toBe(403);
    await expect(rawGet(port, `localhost:${port}`)).resolves.toBe(200);
  });

  it('répond 404 en JSON sur une route inconnue', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/../etc/passwd`);
    expect(res.status).toBe(404);
  });
});

describe('isLoopbackHost', () => {
  it('n’accepte que la loopback', () => {
    expect(isLoopbackHost('127.0.0.1:8853')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]:8853')).toBe(true);
    expect(isLoopbackHost('stellar.local:8853')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.attaquant.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
