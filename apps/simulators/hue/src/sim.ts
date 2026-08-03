import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  buildState,
  isRecord,
  loadFixtureState,
  mergeInto,
  type HueResource,
  type SimLight,
  type SimLightPatch,
  type SimState,
} from './state.js';

/**
 * Simulateur du bridge Philips Hue (CLIP v2) — ADR-010 niveau 2.
 *
 * En **HTTP** et non HTTPS : le driver prend l'URL du bridge en configuration,
 * le certificat autosigné n'existe que sur le vrai matériel (traité côté driver
 * par un dispatcher undici dédié). Un TLS autosigné ici n'apporterait rien
 * qu'un risque de flakiness.
 */
export interface SimHueOptions {
  /** 0 (défaut) = port libre choisi par l'OS — indispensable en test parallèle. */
  port?: number;
  /** État initial du bouton de pairing. */
  linkButtonPressed?: boolean;
  /** Remplace l'état par défaut (fixtures) par un inventaire sur mesure. */
  lights?: SimLight[];
  /** Clé attendue dans `hue-application-key` (et rendue au pairing). */
  applicationKey?: string;
  /** Journal JSON — silencieux par défaut (usage en test). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface SimHue {
  readonly url: string;
  readonly port: number;
  /** État CLIP v2 mutable : inspectable et modifiable directement dans un test. */
  readonly state: SimState;
  readonly applicationKey: string;
  readonly clientKey: string;
  /** Nombre de clients SSE connectés (attente d'établissement dans les tests). */
  readonly eventClients: number;
  pressLinkButton(): void;
  /** Modifie une lampe côté « matériel » et pousse l'événement SSE correspondant. */
  setLight(id: string, patch: SimLightPatch): void;
  close(): Promise<void>;
}

const DEFAULT_APPLICATION_KEY = 'sim-hue-application-key';
const KEEPALIVE_MS = 15_000;

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** Erreur « legacy » (tableau) — la forme que le bridge renvoie sur /api et sur 403. */
const legacyError = (address: string, type: number, description: string): unknown => [
  { error: { type, address, description } },
];

/** Erreur CLIP v2 — enveloppe `{errors, data}`. */
const clipError = (description: string): unknown => ({ errors: [{ description }], data: [] });

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startSimHue(options: SimHueOptions = {}): Promise<SimHue> {
  const applicationKey = options.applicationKey ?? DEFAULT_APPLICATION_KEY;
  const clientKey = randomUUID().replace(/-/g, '').toUpperCase();
  const log = options.log ?? ((): void => undefined);
  const state = options.lights ? buildState(options.lights) : loadFixtureState();

  let linkButtonPressed = options.linkButtonPressed ?? false;
  let eventId = 0;

  const clients = new Set<ServerResponse>();
  const sockets = new Set<Socket>();

  const findLight = (id: string): HueResource | undefined =>
    state.lights.find((light) => light.id === id);

  /** Diffuse un événement `update` à tous les abonnés SSE, au format du bridge. */
  const emitUpdate = (resource: HueResource, patch: Record<string, unknown>): void => {
    eventId += 1;
    const envelope = [
      {
        creationtime: new Date().toISOString(),
        data: [{ id: resource.id, owner: resource['owner'], type: 'light', ...patch }],
        id: randomUUID(),
        type: 'update',
      },
    ];
    const frame = `id: ${eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const applyPatch = (resource: HueResource, patch: Record<string, unknown>): void => {
    mergeInto(resource, patch);
    // Le bridge met à jour son état PUIS notifie : même ordre ici, sinon un
    // consommateur qui relit l'inventaire sur événement verrait l'ancien état.
    emitUpdate(resource, patch);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://sim.local');
    const path = url.pathname;

    // Pairing : seule route ouverte, c'est elle qui délivre la clé.
    if (path === '/api' && method === 'POST') {
      const body = await readBody(req).catch(() => undefined);
      const devicetype = isRecord(body) ? body['devicetype'] : undefined;
      if (typeof devicetype !== 'string' || devicetype.length === 0) {
        send(res, 200, legacyError('/', 5, 'invalid/missing parameters in body'));
        return;
      }
      if (!linkButtonPressed) {
        send(res, 200, legacyError('', 101, 'link button not pressed'));
        return;
      }
      log({ msg: 'pairing accepté', devicetype });
      send(res, 200, [{ success: { username: applicationKey, clientkey: clientKey } }]);
      return;
    }

    if (req.headers['hue-application-key'] !== applicationKey) {
      send(res, 403, legacyError(path, 1, 'unauthorized user'));
      return;
    }

    if (path === '/eventstream/clip/v2' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      log({ msg: 'client event stream connecté', clients: clients.size });
      return;
    }

    const resourceMatch = /^\/clip\/v2\/resource\/(light|device|room)(?:\/([^/]+))?$/.exec(path);
    if (!resourceMatch) {
      send(res, 404, clipError(`resource, ${path}, not available`));
      return;
    }
    const [, rtype, resourceId] = resourceMatch;
    const collection =
      rtype === 'light' ? state.lights : rtype === 'device' ? state.devices : state.rooms;

    if (method === 'GET') {
      const data =
        resourceId === undefined ? collection : collection.filter((r) => r.id === resourceId);
      if (resourceId !== undefined && data.length === 0) {
        send(res, 404, clipError(`resource, /${rtype}/${resourceId}, not available`));
        return;
      }
      send(res, 200, { errors: [], data });
      return;
    }

    if (method === 'PUT' && rtype === 'light' && resourceId !== undefined) {
      const light = findLight(resourceId);
      if (!light) {
        send(res, 404, clipError(`resource, /light/${resourceId}, not available`));
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, clipError('body must be valid JSON'));
        return;
      }
      if (!isRecord(body)) {
        send(res, 400, clipError('body must be a JSON object'));
        return;
      }
      applyPatch(light, body);
      log({ msg: 'light mise à jour', lightId: resourceId });
      send(res, 200, { errors: [], data: [{ rid: resourceId, rtype: 'light' }] });
      return;
    }

    send(res, 405, clipError(`method, ${method}, not available for resource, ${path}`));
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log({ msg: 'erreur interne', error: String(err) });
      if (!res.headersSent) send(res, 500, clipError('internal error'));
      else res.end();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const keepalive = setInterval(() => {
    for (const client of clients) client.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);
  keepalive.unref();

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sim-hue: port inconnu');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    state,
    applicationKey,
    clientKey,
    get eventClients() {
      return clients.size;
    },
    pressLinkButton() {
      linkButtonPressed = true;
      log({ msg: 'bouton du bridge pressé' });
    },
    setLight(id, patch) {
      const light = findLight(id);
      if (!light) throw new Error(`sim-hue: light inconnue ${id}`);
      applyPatch(light, patch as Record<string, unknown>);
    },
    async close() {
      clearInterval(keepalive);
      for (const client of clients) client.end();
      clients.clear();
      // Sans destruction explicite, les sockets keep-alive (SSE) empêchent
      // `server.close()` de rendre la main — et le port de se libérer.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
