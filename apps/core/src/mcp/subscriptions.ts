import { randomUUID } from 'node:crypto';
import { matchesSelector, type Entity, type Selector } from '@stellar/contracts';

/**
 * Registre des abonnements du serveur MCP (P7).
 *
 * **Pourquoi ce registre existe.** La spec §10 nomme un tool `subscribe(selector)`,
 * mais MCP est un protocole requête/réponse : un tool ne peut pas « pousser » un
 * flux à l'agent. La forme retenue est donc un abonnement **matérialisé côté
 * serveur** : `subscribe` enregistre un sélecteur et rend un `subscriptionId`,
 * `poll_subscription` vide le tampon accumulé depuis le dernier appel. L'agent
 * garde la sémantique de la spec (« je m'abonne à ce que je veux surveiller »)
 * sans que le core ait à tenir une connexion ouverte par session éphémère.
 *
 * Trois bornes, toutes nécessaires parce que le producteur (le bus) est bien plus
 * rapide que le consommateur (un agent LLM qui poll de temps en temps) :
 *
 * 1. **tampon FIFO borné** (200) : au-delà, le plus ancien changement est évincé
 *    et compté dans `dropped` — l'agent apprend qu'il a manqué des choses plutôt
 *    que de croire à un flux complet ;
 * 2. **TTL** (10 min sans poll) : une session éphémère qui disparaît sans
 *    ménagement ne doit pas laisser un abonnement grossir pour l'éternité ;
 * 3. **nombre d'abonnements plafonné** (32) : au-delà, le moins récemment
 *    sollicité est évincé.
 *
 * Aucun timer : les purges se font paresseusement, à chaque contact.
 */

/** Changements mémorisés par abonnement avant éviction du plus ancien. */
export const SUBSCRIPTION_BUFFER_MAX = 200;
/** Sans poll pendant ce délai, l'abonnement est oublié. */
export const SUBSCRIPTION_TTL_MS = 600_000;
/** Abonnements simultanés, tous clients confondus. */
export const SUBSCRIPTIONS_MAX = 32;

export interface SubscriptionInfo {
  subscriptionId: string;
  selector: Selector;
  /** Taille du tampon circulaire (au-delà, les plus anciens changements sont perdus). */
  bufferSize: number;
  /** Délai d'oubli sans `poll_subscription`. */
  ttlMs: number;
}

export interface SubscriptionPoll {
  subscriptionId: string;
  /** Changements accumulés depuis le dernier poll, dans l'ordre d'arrivée. */
  changes: Entity[];
  /** Changements évincés faute de place depuis le dernier poll. */
  dropped: number;
}

export interface SubscriptionRegistry {
  create(selector: Selector): SubscriptionInfo;
  /** `undefined` = identifiant inconnu ou abonnement expiré. */
  poll(subscriptionId: string): SubscriptionPoll | undefined;
  /** Branché sur `bus.onState` : range le changement dans les tampons concernés. */
  record(entity: Entity): void;
  readonly size: number;
  clear(): void;
}

export interface SubscriptionRegistryOptions {
  bufferSize?: number;
  ttlMs?: number;
  maxSubscriptions?: number;
  /** Horloge injectable (tests). Défaut `Date.now`. */
  clock?: () => number;
}

interface SubscriptionState {
  id: string;
  selector: Selector;
  buffer: Entity[];
  dropped: number;
  /** Dernier contact du client : création, puis chaque poll. */
  lastSeenAt: number;
}

export function createSubscriptionRegistry(
  options: SubscriptionRegistryOptions = {},
): SubscriptionRegistry {
  const bufferSize = options.bufferSize ?? SUBSCRIPTION_BUFFER_MAX;
  const ttlMs = options.ttlMs ?? SUBSCRIPTION_TTL_MS;
  const maxSubscriptions = options.maxSubscriptions ?? SUBSCRIPTIONS_MAX;
  const clock = options.clock ?? Date.now;

  const subscriptions = new Map<string, SubscriptionState>();

  const purgeExpired = (now: number): void => {
    for (const [id, state] of subscriptions) {
      if (now - state.lastSeenAt > ttlMs) subscriptions.delete(id);
    }
  };

  /** Évince le moins récemment sollicité — jamais celui qu'on vient de créer. */
  const evictLeastRecent = (): void => {
    let oldest: SubscriptionState | undefined;
    for (const state of subscriptions.values()) {
      if (oldest === undefined || state.lastSeenAt < oldest.lastSeenAt) oldest = state;
    }
    if (oldest !== undefined) subscriptions.delete(oldest.id);
  };

  return {
    create(selector) {
      const now = clock();
      purgeExpired(now);
      while (subscriptions.size >= maxSubscriptions) evictLeastRecent();

      const id = randomUUID();
      subscriptions.set(id, { id, selector, buffer: [], dropped: 0, lastSeenAt: now });
      return { subscriptionId: id, selector, bufferSize, ttlMs };
    },

    poll(subscriptionId) {
      const now = clock();
      purgeExpired(now);
      const state = subscriptions.get(subscriptionId);
      if (state === undefined) return undefined;

      const snapshot: SubscriptionPoll = {
        subscriptionId,
        changes: state.buffer,
        dropped: state.dropped,
      };
      // Le tampon est *remis à neuf* (et non vidé sur place) : la liste rendue est
      // celle que l'appelant garde, elle ne doit plus bouger sous ses pieds.
      state.buffer = [];
      state.dropped = 0;
      state.lastSeenAt = now;
      return snapshot;
    },

    record(entity) {
      if (subscriptions.size === 0) return;
      for (const state of subscriptions.values()) {
        if (!matchesSelector(entity, state.selector)) continue;
        state.buffer.push(entity);
        while (state.buffer.length > bufferSize) {
          state.buffer.shift();
          state.dropped += 1;
        }
      }
    },

    get size() {
      return subscriptions.size;
    },

    clear() {
      subscriptions.clear();
    },
  };
}
