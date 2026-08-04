import { randomUUID } from 'node:crypto';
import type { Logger } from '@stellar/bus';
import type { ApprovalRequestView, SetupEvent } from './events.js';

/**
 * Le registre d'approbations — **le remplaçant du système de permissions de
 * Claude Code** dans cette IHM.
 *
 * Tout ce que l'assistant veut faire de sensible (exécuter une commande, écrire
 * ou modifier un fichier) s'arrête ici : une demande part vers le navigateur, la
 * promesse rendue au SDK reste en attente, et rien ne s'exécute tant qu'un humain
 * n'a pas cliqué. Trois principes, non négociables :
 *
 * 1. **Fail-closed.** Tout ce qui n'est pas un « Autoriser » explicite est un
 *    refus : le délai qui expire, l'onglet fermé, l'arrêt du service, l'abandon
 *    du tour. Jamais l'inverse.
 * 2. **Une décision, une fois.** Une demande résolue est retirée de la table ;
 *    un second clic (double-clic, deux onglets ouverts) ne peut pas ré-autoriser.
 * 3. **Traçable.** Chaque décision est journalisée en JSON sur stdout — la
 *    console qui a lancé `pnpm setup:ui` garde la trace de ce qui a été autorisé.
 */

/** Cinq minutes : le temps de lire un diff, pas celui d'aller déjeuner. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface ApprovalDecision {
  allow: boolean;
  /** `human`, `timeout`, `aborted`, `shutdown` — ce qui a tranché. */
  reason: string;
}

export interface ApprovalRegistry {
  /**
   * Demande une approbation et **attend** la réponse humaine.
   * Ne rejette jamais : un échec est un refus motivé.
   */
  request(
    input: Omit<ApprovalRequestView, 'requestId'>,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  /** Réponse venue de `POST /approve`. `false` si l'id est inconnu ou déjà tranché. */
  resolve(requestId: string, allow: boolean): boolean;
  /** Demandes encore en attente — instantané pour une IHM qui (re)connecte. */
  pending(): ApprovalRequestView[];
  /** Refuse tout ce qui reste (arrêt du service). */
  denyAll(reason: string): void;
}

export interface ApprovalRegistryDeps {
  emit: (event: SetupEvent) => void;
  logger: Logger;
  timeoutMs?: number;
  /** Injectable en test : ids stables. */
  newId?: () => string;
}

interface PendingEntry {
  view: ApprovalRequestView;
  settle: (decision: ApprovalDecision) => void;
}

export function createApprovalRegistry(deps: ApprovalRegistryDeps): ApprovalRegistry {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const newId = deps.newId ?? ((): string => randomUUID());
  const entries = new Map<string, PendingEntry>();

  const finish = (requestId: string, decision: ApprovalDecision): boolean => {
    const entry = entries.get(requestId);
    if (entry === undefined) return false;
    entries.delete(requestId);
    deps.logger.info('décision d’approbation', {
      requestId,
      tool: entry.view.tool,
      summary: entry.view.summary,
      allow: decision.allow,
      reason: decision.reason,
    });
    deps.emit({
      type: 'approval-resolved',
      requestId,
      allow: decision.allow,
      reason: decision.reason,
    });
    entry.settle(decision);
    return true;
  };

  return {
    request(input, signal) {
      const requestId = newId();
      const view: ApprovalRequestView = { requestId, ...input };

      return new Promise<ApprovalDecision>((resolve) => {
        const onAbort = (): void => {
          finish(requestId, { allow: false, reason: 'aborted' });
        };
        // Le délai part avant que l'entrée existe : sa mèche est asynchrone, elle
        // ne peut brûler qu'après. C'est ce qui permet à `settle` de le connaître.
        const timer = setTimeout(() => {
          finish(requestId, { allow: false, reason: 'timeout' });
        }, timeoutMs);

        entries.set(requestId, {
          view,
          settle: (decision) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(decision);
          },
        });

        deps.logger.info('approbation demandée', {
          requestId,
          tool: view.tool,
          summary: view.summary,
        });
        deps.emit({ type: 'approval', ...view });

        // Le tour peut être abandonné pendant qu'on attend l'humain : ne pas
        // laisser la promesse (et le sous-process du SDK) pendre indéfiniment.
        if (signal?.aborted === true) {
          finish(requestId, { allow: false, reason: 'aborted' });
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },

    resolve: (requestId, allow) => finish(requestId, { allow, reason: 'human' }),

    pending: () => [...entries.values()].map((entry) => entry.view),

    denyAll(reason) {
      for (const requestId of [...entries.keys()]) finish(requestId, { allow: false, reason });
    },
  };
}
