import type { AddressInfo } from 'node:net';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import { Selector, type Entity, type Health, type Manifest } from '@stellar/contracts';
import type { Journal, JournalQuery, JournalRow } from './journal.js';
import type { Mirror } from './mirror.js';

/**
 * API du core (P5, spec §10) : tRPC servi **en HTTP et en WebSocket sur le même
 * port**, un seul routeur pour les deux (le CLI interroge, une future UI s'abonne).
 *
 * Pas d'authentification : l'API n'écoute que sur la loopback (défaut 127.0.0.1),
 * exactement comme le broker MQTT — la sécurité est celle du LAN et de Tailscale
 * (spec §14). Si mosquitto passe un jour en auth (l'ADR auth de P5 évoqué dans
 * `infra/mosquitto/mosquitto.conf`), cette API doit suivre le même mouvement.
 */

const t = initTRPC.create();

export interface ApiDeps {
  mirror: Mirror;
  journal: Journal;
}

/** Santé d'un driver, aplatie pour le transport (le miroir en tient une Map). */
export interface DriverHealth extends Health {
  driver: string;
}

/**
 * Validateurs d'entrée — zod à chaque frontière (règle n°4 de la spec).
 * `Selector` vient des contrats ; les entrées propres à l'API sont locales.
 * tRPC convertit un échec de parse en BAD_REQUEST (HTTP 400).
 */
const EntityIdInput = z.string().min(1, 'id: string non vide attendu');

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T/;
const isoDate = z.string().regex(ISO_8601, 'date ISO 8601 attendue');

export const JournalQueryInput = z
  .object(
    {
      entityId: z.string().min(1).optional(),
      kind: z.string().min(1).optional(),
      driver: z.string().min(1).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    },
    { invalid_type_error: 'filtres de journal: objet attendu' },
  )
  .strict()
  .optional();

export const parseJournalQuery = (input: unknown): JournalQuery => {
  return JournalQueryInput.parse(input) ?? {};
};

export function createAppRouter(deps: ApiDeps) {
  const { mirror, journal } = deps;

  return t.router({
    /** États du miroir filtrés par sélecteur (kind/room/driver/id). */
    getStates: t.procedure
      .input(Selector.optional())
      .query(({ input }): Entity[] => mirror.getStates(input ?? {})),

    /** `null` (et pas `undefined`) : le JSON de sortie doit porter l'absence. */
    getState: t.procedure
      .input(EntityIdInput)
      .query(({ input }): Entity | null => mirror.getState(input) ?? null),

    /** Agrégat des manifestes discovery — base du futur `list_capabilities` (P7). */
    capabilities: t.procedure.query((): Manifest[] => [...mirror.getManifests().values()]),

    health: t.procedure.query((): DriverHealth[] =>
      [...mirror.getHealth().entries()].map(([driver, health]) => ({ driver, ...health })),
    ),

    journal: t.router({
      query: t.procedure
        .input(parseJournalQuery)
        .query(({ input }): JournalRow[] => journal.query(input)),
      count: t.procedure.query((): number => journal.count()),
    }),
  });
}

/**
 * Type consommé par les futurs clients (cli, UI) — jamais la valeur, seulement le type.
 *
 * Côté serveur (et côté tests), `createAppRouter(deps).createCaller({})` donne un
 * appelant en process : c'est l'usage documenté de tRPC, sans dépendance client.
 */
export type AppRouter = ReturnType<typeof createAppRouter>;

export interface ApiServerOptions extends ApiDeps {
  /** 0 = port éphémère (tests). */
  port: number;
  /** Loopback par défaut : l'API n'est pas authentifiée. */
  host?: string;
}

export interface ApiServer {
  /** Port réellement écouté (utile quand `port: 0`). */
  readonly port: number;
  readonly router: AppRouter;
  close(): Promise<void>;
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { port, host = '127.0.0.1', ...deps } = options;
  const router = createAppRouter(deps);

  const server = createHTTPServer({ router, createContext: () => ({}) });
  // Le WebSocket se greffe sur le MÊME serveur HTTP : un port, un routeur, deux
  // transports (spec §10 « API : WebSocket + tRPC »).
  const wss = new WebSocketServer({ server });
  const wsHandler = applyWSSHandler({ wss, router, createContext: () => ({}) });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("l'API n'a pas de port");

  return {
    port: address.port,
    router,
    async close() {
      wsHandler.broadcastReconnectNotification();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // Les clients HTTP gardent la connexion vivante (keep-alive) : sans ça,
      // `server.close()` attendrait leur expiration et l'arrêt traînerait.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
