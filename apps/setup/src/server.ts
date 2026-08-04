import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Logger } from '@stellar/bus';
import type { ApprovalRegistry } from './approvals.js';
import type { EventStream } from './events.js';
import { uiHtmlPath } from './paths.js';
import type { SetupSession } from './session.js';
import type { SetupStatus } from './status.js';

/**
 * La prise HTTP de l'IHM de setup — `node:http` nu, aucune dépendance web.
 *
 * Cinq routes, pas une de plus :
 * - `GET /`        la page (un seul fichier, servi tel quel) ;
 * - `GET /events`  le flux SSE (assistant, approbations, fins de tour) ;
 * - `POST /message` un tour humain ;
 * - `POST /approve` la réponse à une carte d'approbation ;
 * - `GET /status`  les trois voyants du bandeau.
 *
 * Le serveur n'écoute que la **loopback**, et refuse tout de même les requêtes
 * dont l'`Host` n'est pas loopback : c'est la parade au *DNS rebinding*, la seule
 * façon dont une page web ouverte par ailleurs pourrait atteindre un service
 * local. Le coût est nul, l'oubli coûterait cher — ce service exécute des
 * commandes.
 */

const MAX_BODY_BYTES = 65_536;
const MAX_MESSAGE_CHARS = 8_000;

const MessageRequest = z
  .object({ text: z.string().trim().min(1, 'message vide').max(MAX_MESSAGE_CHARS) })
  .strict();

const ApproveRequest = z.object({ requestId: z.string().min(1), allow: z.boolean() }).strict();

export interface SetupServerDeps {
  logger: Logger;
  stream: EventStream;
  approvals: ApprovalRegistry;
  /** Absente quand l'IHM tourne sans session (test, ou démarrage dégradé). */
  session?: SetupSession;
  status: () => Promise<SetupStatus>;
  /** Défaut : le `ui.html` voisin de ce module. Injecté en test. */
  htmlPath?: string;
}

export interface SetupServer {
  server: Server;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

/** `127.0.0.1:8853`, `localhost:8853`, `[::1]:8853` — et rien d'autre. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : (host.split(':')[0] ?? '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

export function createSetupServer(deps: SetupServerDeps): SetupServer {
  const htmlPath = deps.htmlPath ?? uiHtmlPath();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'IHM de setup : accès loopback uniquement' });
      return;
    }

    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      // Relu à chaque requête : le html est modifiable sans rebuild ni redémarrage.
      const html = await readFile(htmlPath, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (method === 'GET' && path === '/events') {
      const lastEventId = req.headers['last-event-id'];
      deps.stream.attach(res, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      return;
    }

    if (method === 'GET' && path === '/status') {
      sendJson(res, 200, await deps.status());
      return;
    }

    if (method === 'POST' && path === '/message') {
      if (deps.session === undefined) {
        sendJson(res, 400, {
          error:
            'aucune session : l’IHM tourne sans session Claude (ANTHROPIC_API_KEY absente au démarrage)',
        });
        return;
      }
      const body = MessageRequest.safeParse(await readJsonBody(req));
      if (!body.success) {
        sendJson(res, 400, { error: 'requête invalide', issues: body.error.issues });
        return;
      }
      if (deps.session.busy()) {
        sendJson(res, 409, { error: 'un tour est déjà en cours' });
        return;
      }
      deps.session.send(body.data.text);
      sendJson(res, 202, { accepted: true });
      return;
    }

    if (method === 'POST' && path === '/approve') {
      const body = ApproveRequest.safeParse(await readJsonBody(req));
      if (!body.success) {
        sendJson(res, 400, { error: 'requête invalide', issues: body.error.issues });
        return;
      }
      // Un id inconnu = une demande déjà tranchée (timeout, double-clic, second
      // onglet). Ce n'est pas une erreur serveur : c'est une décision arrivée trop
      // tard, et elle ne doit surtout pas ré-autoriser quoi que ce soit.
      const resolved = deps.approvals.resolve(body.data.requestId, body.data.allow);
      sendJson(res, resolved ? 200 : 409, {
        resolved,
        ...(resolved ? {} : { error: 'demande inconnue ou déjà tranchée' }),
      });
      return;
    }

    sendJson(res, 404, { error: `route inconnue : ${method} ${path}` });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      deps.logger.error('requête en échec', { error: String(err) });
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: 'erreur interne' });
    });
  });

  return {
    server,
    listen: (port, host) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      }),
    close() {
      deps.stream.close();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
