import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import {
  Kind as KindEnum,
  Selector,
  type Command,
  type EntityDecl,
  type Health,
  type Kind,
  type Manifest,
} from '@stellar/contracts';
import { JournalQueryInput, parseJournalQuery } from '../api.js';
import type { Journal } from '../journal.js';
import type { Mirror } from '../mirror.js';
import { loadRegulationConfig } from '../regulation/index.js';
import {
  createSubscriptionRegistry,
  type SubscriptionRegistry,
  type SubscriptionRegistryOptions,
} from './subscriptions.js';

/**
 * Serveur MCP du core (P7, spec §10) — **l'unique porte d'entrée de l'agent**.
 *
 * Il ne décide rien et ne duplique rien : chaque tool est une vue sur des
 * composants qui existent déjà (miroir, journal, bus). Ce qui lui appartient en
 * propre tient en trois points :
 *
 * 1. **Les garde-fous.** Toute commande passe par le miroir : une entité absente
 *    n'est pas commandable, et une entité d'un `kind` interdit à l'agent ne l'est
 *    jamais (spec §4 n°1 et §11 : jamais `lock`, jamais la sécurité). Le refus est
 *    une erreur d'outil propre, et **rien ne part sur le bus**.
 * 2. **La provenance.** `issuedBy` est forcé à `'agent'`, l'appelant ne peut pas
 *    en décider : c'est ce qui rend chaque action de l'agent relisible dans le
 *    journal (DoD P7 : « pourquoi la clim a tourné cette nuit ? »).
 * 3. **La traçabilité.** Chaque appel de tool est loggé (nom, entrée résumée,
 *    durée, issue) — le budget et la traçabilité de la spec §11 commencent ici.
 *
 * Transport : **HTTP streamable**, le transport officiel du SDK, sur un port
 * dédié en loopback. Le consommateur (`apps/agent`) est un service réseau local,
 * pas un sous-process : stdio ne conviendrait pas.
 */

/** Chemin monté par le serveur HTTP. */
export const MCP_PATH = '/mcp';
/** Port par défaut (spec : loopback, comme l'API tRPC). */
export const CORE_MCP_DEFAULT_PORT = 8851;
/** Timeout des commandes émises par l'agent (spec §11 : timeout sur tout tool call). */
export const MCP_COMMAND_TIMEOUT_MS = 5_000;
/** Sessions MCP simultanées ; au-delà, la moins récente est fermée. */
const MCP_SESSIONS_MAX = 16;
/** Un `initialize` fait quelques centaines d'octets : 1 Mio est déjà généreux. */
const MAX_BODY_BYTES = 1_048_576;

const SERVER_NAME = 'stellar-core';
const SERVER_VERSION = '0.1.0';

/**
 * Kinds que l'agent ne pilote **jamais** :
 *
 * - `lock` : interdit absolu (spec §4 n°1, §11, CLAUDE.md) — une serrure ne se
 *   pilote pas depuis un modèle non déterministe, quelles que soient les
 *   circonstances ;
 * - `cover`, `button`, `doorbell` : réservés futur (contrats §7). Tant qu'aucun
 *   driver ne les publie, leur sémantique de commande n'est pas définie ; laisser
 *   l'agent tirer dessus « au cas où » reviendrait à valider un contrat qui
 *   n'existe pas. Le jour où ils arrivent, on retire la ligne **avec** l'ADR qui
 *   décrit ce que l'agent a le droit d'en faire.
 */
export const AGENT_FORBIDDEN_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  KindEnum.enum.lock,
  KindEnum.enum.cover,
  KindEnum.enum.button,
  KindEnum.enum.doorbell,
]);

export interface McpToolDeps {
  mirror: Mirror;
  journal: Journal;
  bus: Bus;
  logger: Logger;
  /**
   * Chemin de `config/regulation.yaml`, en **lecture seule** : `get_regulation_config`
   * répond une erreur d'outil s'il est absent. L'écriture (`propose_regulation_change`)
   * vit dans l'agent, jamais ici.
   */
  regulationConfigPath?: string;
  /** Défaut `MCP_COMMAND_TIMEOUT_MS`. */
  commandTimeoutMs?: number;
  subscriptions?: SubscriptionRegistryOptions;
}

export interface McpServerOptions extends McpToolDeps {
  /** 0 = port éphémère (tests). */
  port: number;
  /** Loopback par défaut : le serveur n'est pas authentifié (spec §14). */
  host?: string;
}

export interface McpHttpServer {
  /** Port réellement écouté (utile quand `port: 0`). */
  readonly port: number;
  /** URL complète à donner à un client MCP. */
  readonly url: string;
  /** Sessions MCP ouvertes (introspection, tests). */
  readonly sessions: number;
  close(): Promise<void>;
}

// ───────────────────────────── résultats d'outil ─────────────────────────────

/**
 * Un résultat d'outil MCP porte toujours du texte (ce que le modèle lit) et, en
 * doublon, la même donnée structurée (ce qu'un client typé exploite).
 */
function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Refus ou échec métier : `isError` plutôt qu'une exception JSON-RPC. C'est la
 * forme prévue par MCP pour qu'un modèle **voie** l'erreur et puisse se corriger,
 * au lieu de recevoir une panne de transport.
 */
function toolError(message: string, details: Record<string, unknown> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message, ...details },
    isError: true,
  };
}

/** Entrée résumée pour les logs : bornée, et passée au masquage du logger. */
function summarizeInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    return '[illisible]';
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// ──────────────────────────────── les tools ────────────────────────────────

/**
 * Filtres du journal : **le validateur de l'API tRPC lui-même**, jamais redéfini
 * ici. Il est passé en schéma d'objet (et non en `shape`) pour que son `.strict()`
 * survive : une clé inventée par le modèle doit être refusée, pas silencieusement
 * ignorée — sinon l'agent croit avoir filtré et lit tout le journal.
 */
const journalFilterSchema = JournalQueryInput.unwrap();

const sendCommandShape = {
  target: z.string().min(1).describe('entityId de la cible, tel que rendu par get_state'),
  action: z
    .string()
    .min(1)
    .describe('action déclarée par le manifeste du driver (list_capabilities)'),
  params: z.record(z.unknown()).optional().describe('paramètres de l’action'),
};

const pollShape = {
  subscriptionId: z.string().uuid().describe('identifiant rendu par subscribe'),
};

/**
 * Construit un serveur MCP branché sur les composants du core. Une instance par
 * session HTTP (le SDK lie un serveur à un transport) ; l'état partagé — le
 * registre d'abonnements — est passé de l'extérieur.
 */
export function createMcpServer(deps: McpToolDeps, subscriptions: SubscriptionRegistry): McpServer {
  const { mirror, journal, bus, logger } = deps;
  const commandTimeoutMs = deps.commandTimeoutMs ?? MCP_COMMAND_TIMEOUT_MS;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  /**
   * Journalise l'appel et **absorbe toute exception** : une entrée aberrante doit
   * produire une erreur d'outil, jamais l'arrêt du serveur (spec §11).
   */
  const instrument =
    <A>(tool: string, handler: (args: A) => CallToolResult | Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      const startedAt = Date.now();
      try {
        const result = await handler(args);
        logger.info('appel de tool MCP', {
          tool,
          input: summarizeInput(args),
          durationMs: Date.now() - startedAt,
          outcome: result.isError === true ? 'error' : 'ok',
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('tool MCP en échec', {
          tool,
          input: summarizeInput(args),
          durationMs: Date.now() - startedAt,
          error: message,
        });
        return toolError(`échec du tool ${tool} : ${message}`, { code: 'tool_failure' });
      }
    };

  server.registerTool(
    'get_state',
    {
      title: 'États du miroir',
      description:
        "Entités connues du miroir, filtrées par sélecteur (kind, room, driver, id). Sans filtre : tout l'état de la maison.",
      inputSchema: Selector.shape,
    },
    instrument('get_state', (selector: Selector) => {
      const entities = mirror.getStates(selector);
      return ok({ count: entities.length, entities });
    }),
  );

  server.registerTool(
    'send_command',
    {
      title: 'Commander une entité',
      description:
        "Envoie une commande à une entité et attend son acquittement (5 s). Le driver destinataire est résolu par le miroir ; l'émetteur est toujours 'agent'. Refusé pour les entités inconnues et pour les kinds de sécurité (lock) ou réservés (cover, button, doorbell).",
      inputSchema: sendCommandShape,
    },
    instrument(
      'send_command',
      async (args: { target: string; action: string; params?: Record<string, unknown> }) => {
        // ADR-008 : le driver destinataire est une donnée du miroir, jamais un nom
        // écrit dans le core. Corollaire utile : une entité que le miroir ignore
        // n'est pas commandable — le garde-fou et le transport sont le même geste.
        const entity = mirror.getState(args.target);
        if (entity === undefined) {
          return toolError(`entité inconnue du miroir : ${args.target}`, {
            code: 'unknown_entity',
            target: args.target,
          });
        }
        if (AGENT_FORBIDDEN_KINDS.has(entity.kind)) {
          return toolError(
            `commande refusée : l'agent ne pilote pas les entités de kind '${entity.kind}'`,
            { code: 'forbidden_kind', target: args.target, kind: entity.kind },
          );
        }

        const command: Command = {
          id: randomUUID(),
          target: args.target,
          action: args.action,
          params: args.params ?? {},
          // Forcé, jamais lu de l'entrée : c'est la provenance qui rend l'action
          // relisible dans le journal (spec §11).
          issuedBy: 'agent',
          ts: new Date().toISOString(),
        };

        const ack = await bus.sendCommand(command, {
          driver: entity.driver,
          timeoutMs: commandTimeoutMs,
        });

        const payload: Record<string, unknown> = {
          commandId: command.id,
          target: command.target,
          action: command.action,
          status: ack.status,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        };
        // Un refus ou un timeout du matériel est un échec pour l'agent : il doit le
        // voir comme tel, pas le confondre avec un succès silencieux.
        return ack.status === 'ok'
          ? ok(payload)
          : toolError(`commande non acquittée (${ack.status})`, payload);
      },
    ),
  );

  server.registerTool(
    'subscribe',
    {
      title: 'Suivre des changements d’état',
      description:
        "Enregistre un sélecteur et rend un subscriptionId. MCP étant requête/réponse, les changements ne sont pas poussés : ils s'accumulent côté core dans un tampon borné et se récupèrent avec poll_subscription.",
      inputSchema: Selector.shape,
    },
    instrument('subscribe', (selector: Selector) => {
      const info = subscriptions.create(selector);
      return ok({ ...info, note: 'récupérer les changements avec poll_subscription' });
    }),
  );

  server.registerTool(
    'poll_subscription',
    {
      title: 'Relever un abonnement',
      description:
        "Rend les changements accumulés depuis le dernier relevé, puis vide le tampon. `dropped` compte les changements perdus faute de place. L'abonnement est oublié après 10 minutes sans relevé.",
      inputSchema: pollShape,
    },
    instrument('poll_subscription', (args: { subscriptionId: string }) => {
      const poll = subscriptions.poll(args.subscriptionId);
      if (poll === undefined) {
        return toolError(`abonnement inconnu ou expiré : ${args.subscriptionId}`, {
          code: 'unknown_subscription',
          subscriptionId: args.subscriptionId,
        });
      }
      return ok({ ...poll, count: poll.changes.length });
    }),
  );

  server.registerTool(
    'list_capabilities',
    {
      title: 'Capacités de la maison',
      description:
        'Agrégat des manifestes de découverte (entités et actions publiées par chaque driver) et de la santé de chacun. Un équipement branché à chaud y apparaît sans redéploiement.',
      inputSchema: {},
    },
    instrument('list_capabilities', () => {
      const manifests = mirror.getManifests();
      const health = mirror.getHealth();
      // Un driver peut être vivant sans manifeste (démarrage) ou avoir laissé un
      // manifeste retained sans être vivant (arrêt) : l'union des deux dit la vérité.
      const names = [...new Set([...manifests.keys(), ...health.keys()])].sort();
      const drivers = names.map((driver) => {
        const manifest = manifests.get(driver);
        return {
          driver,
          version: manifest?.version ?? null,
          entities: manifest?.entities ?? ([] as EntityDecl[]),
          commands: manifest?.commands ?? ([] as Manifest['commands']),
          health: health.get(driver) ?? (null as Health | null),
        };
      });
      return ok({ count: drivers.length, drivers });
    }),
  );

  server.registerTool(
    'query_journal',
    {
      title: 'Interroger le journal',
      description:
        "Lignes du journal append-only (tout ce qui a transité sur le bus), filtrables par entité, kind, driver et période. `issuedBy` dit qui a émis une commande — c'est ce qui permet d'expliquer une décision passée.",
      inputSchema: journalFilterSchema,
    },
    instrument('query_journal', (args: unknown) => {
      const rows = journal.query(parseJournalQuery(args));
      return ok({ count: rows.length, rows });
    }),
  );

  server.registerTool(
    'get_regulation_config',
    {
      title: 'Paramètres de régulation',
      description:
        "Contenu validé de config/regulation.yaml (consignes, politique Tempo, délestage) — lecture seule. C'est la référence pour expliquer une décision de régulation.",
      inputSchema: {},
    },
    instrument('get_regulation_config', () => {
      const path = deps.regulationConfigPath;
      if (path === undefined) {
        return toolError('aucune configuration de régulation n’est branchée sur ce core', {
          code: 'regulation_config_unavailable',
        });
      }
      // Relu à chaque appel : le fichier peut avoir changé depuis le démarrage
      // (c'est le seul que l'agent puisse faire modifier, après validation humaine).
      return ok({ path, config: loadRegulationConfig(path) });
    }),
  );

  return server;
}

// ─────────────────────────────── transport HTTP ───────────────────────────────

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsedAt: number;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** Lecture bornée du corps : le transport a besoin du body déjà parsé sur `initialize`. */
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
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

export async function startMcpServer(options: McpServerOptions): Promise<McpHttpServer> {
  const { port, host = '127.0.0.1', ...deps } = options;
  const { bus, logger } = deps;

  const subscriptions = createSubscriptionRegistry(deps.subscriptions ?? {});
  // Filtre `home/state/#` — exactement celui que le miroir pose déjà : souscrire
  // deux fois au même filtre remplace la souscription, donc aucune livraison en
  // double et aucune entrée de journal dupliquée (cf. JOURNAL_FILTERS, core.ts).
  await bus.onState({}, (entity) => subscriptions.record(entity));

  const sessions = new Map<string, McpSession>();

  const closeSession = async (session: McpSession): Promise<void> => {
    // `server.close()` ferme aussi son transport (le serveur en est propriétaire).
    await session.server.close().catch((err: unknown) => {
      logger.warn('fermeture de session MCP en échec', { error: String(err) });
    });
  };

  const openSession = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    while (sessions.size >= MCP_SESSIONS_MAX) {
      let oldest: [string, McpSession] | undefined;
      for (const entry of sessions) {
        if (oldest === undefined || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
      }
      if (oldest === undefined) break;
      sessions.delete(oldest[0]);
      logger.warn('session MCP évincée (plafond atteint)', { sessionId: oldest[0] });
      await closeSession(oldest[1]);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Réponses JSON plutôt que SSE : le core ne pousse aucune notification
      // (le suivi d'état passe par subscribe/poll), et une réponse close laisse
      // moins de sockets ouvertes à l'arrêt.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        logger.info('session MCP ouverte', { sessionId: id, sessions: sessions.size });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        logger.info('session MCP fermée', { sessionId: id, sessions: sessions.size });
      },
    });
    const server = createMcpServer(deps, subscriptions);
    const session: McpSession = { transport, server, lastUsedAt: Date.now() };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== MCP_PATH) {
      sendJsonRpcError(
        res,
        404,
        -32004,
        `chemin inconnu — le serveur MCP est monté sur ${MCP_PATH}`,
      );
      return;
    }

    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId !== undefined && sessionId.length > 0) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        sendJsonRpcError(res, 404, -32001, 'session MCP inconnue ou expirée');
        return;
      }
      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      sendJsonRpcError(res, 405, -32000, 'hors session, seul un POST initialize est accepté');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJsonRpcError(res, 400, -32700, `corps de requête illisible : ${String(err)}`);
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(res, 400, -32000, 'hors session, seul initialize est accepté');
      return;
    }

    await openSession(req, res, body);
  };

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error('requête MCP en échec', { error: String(err) });
      if (res.headersSent) res.end();
      else sendJsonRpcError(res, 500, -32603, 'erreur interne du serveur MCP');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  if (address === null) throw new Error("le serveur MCP n'a pas de port");

  return {
    port: address.port,
    url: `http://${host}:${address.port}${MCP_PATH}`,
    get sessions() {
      return sessions.size;
    },
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(closeSession));
      subscriptions.clear();
      // Comme l'API tRPC : sans ça, le keep-alive des clients ferait traîner l'arrêt.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
