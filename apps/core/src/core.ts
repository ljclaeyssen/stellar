import type { Bus, Logger } from '@stellar/bus';
import type { Kind } from '@stellar/contracts';
import { startApiServer, type ApiServer } from './api.js';
import { createJournal, journalEntryFromMessage, type Journal } from './journal.js';
import { createMirror, type Mirror } from './mirror.js';
import { createStaleWatcher, type StaleWatcher } from './stale.js';

/**
 * Assemblage du core (miroir + journal + détection stale + API).
 *
 * Extrait de `main.ts` pour être montable en test : `main.ts` ne fait plus que
 * lire l'environnement, ouvrir le bus, appeler `createCore` et gérer l'arrêt.
 */

export interface CoreOptions {
  bus: Bus;
  logger: Logger;
  /** Chemin SQLite ou ':memory:'. */
  journalPath: string;
  /** 0 = port éphémère ; `null` = pas d'API (tests unitaires). */
  apiPort?: number | null;
  apiHost?: string;
  staleThresholds?: Partial<Record<Kind, number>>;
  staleCheckIntervalMs?: number;
  /** Horloge de la détection stale (tests). */
  clock?: () => number;
}

export interface Core {
  mirror: Mirror;
  journal: Journal;
  staleWatcher: StaleWatcher;
  /** `null` quand `apiPort: null`. */
  api: ApiServer | null;
  close(): Promise<void>;
}

/**
 * Filtres de journalisation.
 *
 * Ils sont **volontairement décomposés** plutôt qu'un simple `home/#` : MQTT
 * autorise le broker à délivrer un message une fois par souscription qui
 * correspond (mosquitto le fait). Un `home/#` qui recouvrirait le `home/state/#`
 * du miroir ferait donc entrer deux fois chaque état dans le journal. Ici chaque
 * filtre est soit identique à celui que le bus/miroir pose déjà (souscrire deux
 * fois au même filtre remplace la souscription, sans duplication), soit disjoint.
 *
 * Invariant à maintenir : si le core se met un jour à consommer des commandes
 * (`bus.onCommand`, filtre `home/cmd/core/+`) ou des événements ciblés
 * (`bus.onEvent`), il faudra aligner les filtres ci-dessous pour rester disjoint.
 */
const JOURNAL_FILTERS = [
  'home/state/#',
  'home/cmd/#',
  'home/ack/+',
  'home/event/#',
  'home/discovery/+',
  'home/health/+',
];

export async function createCore(options: CoreOptions): Promise<Core> {
  const { bus, logger, journalPath } = options;

  const journal = createJournal({ path: journalPath });

  // Alimentation du journal : abonnement brut, AVANT le miroir, pour qu'aucun
  // retained servi au démarrage n'échappe au journal.
  bus.client.on('message', (topic, payload) => {
    if (!topic.startsWith('home/')) return;
    try {
      journal.append(journalEntryFromMessage(topic, payload.toString(), new Date().toISOString()));
    } catch (err) {
      // Une écriture ratée ne doit pas emporter le core : le miroir, lui, continue.
      logger.error('écriture journal en échec', { topic, error: String(err) });
    }
  });
  await bus.client.subscribeAsync(JOURNAL_FILTERS, { qos: 1 });

  const mirror = await createMirror({ bus, logger });

  const staleWatcher = createStaleWatcher({
    mirror,
    bus,
    logger,
    ...(options.staleThresholds !== undefined ? { thresholds: options.staleThresholds } : {}),
    ...(options.staleCheckIntervalMs !== undefined
      ? { checkIntervalMs: options.staleCheckIntervalMs }
      : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  const api =
    options.apiPort === null || options.apiPort === undefined
      ? null
      : await startApiServer({
          mirror,
          journal,
          port: options.apiPort,
          ...(options.apiHost !== undefined ? { host: options.apiHost } : {}),
        });

  return {
    mirror,
    journal,
    staleWatcher,
    api,
    async close() {
      staleWatcher.close();
      await api?.close();
      // Le bus n'appartient pas au core : c'est l'appelant qui le ferme, et il doit
      // le faire AVANT (un message arrivant après `journal.close()` ne serait plus
      // journalisé — l'erreur est rattrapée, mais le fait serait perdu).
      journal.close();
    },
  };
}
