import type { ServerResponse } from 'node:http';

/**
 * Le flux d'événements de l'IHM (SSE) — **le seul canal serveur → navigateur**.
 *
 * SSE plutôt que WebSocket : le flux est unidirectionnel (les réponses humaines
 * repassent par de banals `POST`), il reconnecte tout seul, et il ne coûte aucune
 * dépendance — `node:http` suffit, comme partout ailleurs dans ce dépôt.
 *
 * Deux garanties utiles à une IHM qui peut perdre sa connexion en plein pairing :
 * - un **tampon** des derniers événements, rejoué sur `Last-Event-ID` ;
 * - un **instantané** (les approbations encore en attente) poussé à toute nouvelle
 *   connexion sans `Last-Event-ID`, pour qu'un rechargement de page ne perde pas
 *   la carte d'approbation en cours.
 */

export interface ApprovalRequestView {
  requestId: string;
  tool: string;
  /** Une ligne : ce que la carte affiche en titre. */
  summary: string;
  /** Commande, contenu ou diff — tronqué et masqué. */
  detail: string;
}

export type SetupEvent =
  /** Ouverture de flux : l'IHM sait qu'elle est connectée. */
  | { type: 'hello'; pending: ApprovalRequestView[] }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  /** Tool auto-approuvé (lecture seule) — trace, sans interaction. */
  | { type: 'tool'; tool: string; summary: string }
  | ({ type: 'approval' } & ApprovalRequestView)
  | { type: 'approval-resolved'; requestId: string; allow: boolean; reason: string }
  | { type: 'turn-end'; isError: boolean; errorReason?: string }
  | { type: 'error'; message: string };

export interface EventStream {
  /**
   * Propriété et non méthode : `emit` est systématiquement **détaché** de son
   * objet (`{ emit: stream.emit }` chez le registre et la session). Le typer en
   * fonction rend ce détachement légitime plutôt que suspect (`unbound-method`).
   */
  emit: (event: SetupEvent) => void;
  /** Branche une réponse HTTP sur le flux (en-têtes SSE compris). */
  attach(res: ServerResponse, lastEventId?: string): void;
  /** Ferme proprement tous les clients (arrêt du service). */
  close(): void;
  /** Nombre de clients branchés — utile aux tests et aux logs. */
  clientCount(): number;
}

export interface EventStreamDeps {
  /** Approbations encore en attente, poussées à la connexion. */
  pending?: () => ApprovalRequestView[];
  /** Taille du tampon de rejeu. */
  bufferSize?: number;
}

const DEFAULT_BUFFER_SIZE = 200;
/** Commentaire SSE périodique : garde la connexion en vie derrière un proxy local. */
const KEEPALIVE_MS = 20_000;

export function createEventStream(deps: EventStreamDeps = {}): EventStream {
  const bufferSize = deps.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const clients = new Set<ServerResponse>();
  const buffer: { id: number; event: SetupEvent }[] = [];
  let nextId = 1;
  let keepalive: NodeJS.Timeout | undefined;

  const frame = (id: number, event: SetupEvent): string =>
    `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;

  const startKeepalive = (): void => {
    if (keepalive !== undefined) return;
    keepalive = setInterval(() => {
      for (const client of clients) client.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    // Ne doit pas maintenir le process en vie à lui seul.
    keepalive.unref();
  };

  const stopKeepalive = (): void => {
    if (keepalive === undefined || clients.size > 0) return;
    clearInterval(keepalive);
    keepalive = undefined;
  };

  return {
    emit(event) {
      const id = nextId++;
      buffer.push({ id, event });
      if (buffer.length > bufferSize) buffer.shift();
      const payload = frame(id, event);
      for (const client of clients) client.write(payload);
    },

    attach(res, lastEventId) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Ceinture et bretelles derrière un éventuel proxy local.
        'x-accel-buffering': 'no',
      });
      // 2 s : l'IHM revient vite après un redémarrage du serveur de setup.
      res.write('retry: 2000\n\n');

      const since = Number(lastEventId);
      if (Number.isFinite(since) && since > 0) {
        for (const entry of buffer) {
          if (entry.id > since) res.write(frame(entry.id, entry.event));
        }
      } else {
        // Connexion neuve (ou rechargement de page) : on ne rejoue pas l'historique,
        // mais on redonne ce qui attend une décision humaine.
        res.write(frame(0, { type: 'hello', pending: deps.pending?.() ?? [] }));
      }

      clients.add(res);
      startKeepalive();
      res.on('close', () => {
        clients.delete(res);
        stopKeepalive();
      });
    },

    close() {
      for (const client of clients) client.end();
      clients.clear();
      stopKeepalive();
    },

    clientCount: () => clients.size,
  };
}
