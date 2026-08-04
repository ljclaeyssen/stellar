import { existsSync } from 'node:fs';
import type { Bus, Logger } from '@stellar/bus';
import type { Kind } from '@stellar/contracts';
import { startApiServer, type ApiServer } from './api.js';
import { createJournal, journalEntryFromMessage, type Journal } from './journal.js';
import { CORE_MCP_DEFAULT_PORT, startMcpServer, type McpHttpServer } from './mcp/index.js';
import { createMirror, type Mirror } from './mirror.js';
import { createRegulation, loadRegulationConfig, type Regulation } from './regulation/index.js';
import { createStaleWatcher, type StaleWatcher } from './stale.js';

/**
 * Assemblage du core (miroir + journal + détection stale + API + régulation).
 *
 * Extrait de `main.ts` pour être montable en test : `main.ts` ne fait plus que
 * lire l'environnement, ouvrir le bus, appeler `createCore` et gérer l'arrêt.
 */

export interface RegulationCoreOptions {
  /** Chemin de `config/regulation.yaml`. */
  configPath: string;
  /** Défaut 60 s. */
  evaluateIntervalMs?: number;
  /**
   * Par défaut : activée si le fichier existe. `true` exige le fichier (absent ⇒
   * démarrage refusé), `false` la désactive même si le fichier est là.
   */
  enabled?: boolean;
  /** Regroupement des réévaluations déclenchées par le miroir (tests). */
  triggerDebounceMs?: number;
}

export interface McpCoreOptions {
  /** 0 = port éphémère (tests). Défaut `CORE_MCP_DEFAULT_PORT` (8851). */
  port?: number;
  /** Loopback par défaut : le serveur MCP n'est pas authentifié (spec §14). */
  host?: string;
  /** Défaut : activé — l'agent est un consommateur de première classe du core. */
  enabled?: boolean;
  /**
   * Fichier lu par `get_regulation_config`. Défaut : celui de la régulation quand
   * elle est configurée — un core qui régule sait toujours expliquer avec quoi.
   */
  regulationConfigPath?: string;
}

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
  /** Horloge de la détection stale et de la régulation (tests). */
  clock?: () => number;
  /** Absent = pas de régulation du tout (tests unitaires du miroir/journal). */
  regulation?: RegulationCoreOptions;
  /** Serveur MCP (P7). Absent = valeurs par défaut, donc **activé**. */
  mcp?: McpCoreOptions;
}

export interface Core {
  mirror: Mirror;
  journal: Journal;
  staleWatcher: StaleWatcher;
  /** `null` quand `apiPort: null`. */
  api: ApiServer | null;
  /** `null` quand la régulation est désactivée ou sans fichier de configuration. */
  regulation: Regulation | null;
  /** `null` quand `mcp: { enabled: false }`. */
  mcp: McpHttpServer | null;
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

/**
 * Montage de la régulation (P6).
 *
 * Politique de démarrage : une configuration **présente mais invalide** fait
 * échouer le démarrage (mieux vaut pas de core qu'un core qui régule de travers) ;
 * une configuration **absente** ne fait qu'éteindre la régulation — sauf si
 * l'appelant l'a explicitement exigée.
 */
async function startRegulation(
  options: CoreOptions,
  mirror: Mirror,
  bus: Bus,
  logger: Logger,
): Promise<Regulation | null> {
  const settings = options.regulation;
  if (!settings || settings.enabled === false) return null;

  if (!existsSync(settings.configPath)) {
    if (settings.enabled === true) {
      throw new Error(`régulation exigée mais configuration absente : ${settings.configPath}`);
    }
    logger.info('régulation inactive : aucun fichier de configuration', {
      path: settings.configPath,
    });
    return null;
  }

  const config = loadRegulationConfig(settings.configPath);
  const regulation = await createRegulation({
    mirror,
    bus,
    logger,
    config,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(settings.evaluateIntervalMs !== undefined
      ? { evaluateIntervalMs: settings.evaluateIntervalMs }
      : {}),
    ...(settings.triggerDebounceMs !== undefined
      ? { triggerDebounceMs: settings.triggerDebounceMs }
      : {}),
  });
  logger.info('régulation active', {
    path: settings.configPath,
    rooms: Object.keys(config.rooms),
  });
  return regulation;
}

/**
 * Montage du serveur MCP (P7).
 *
 * Il ne reçoit que des composants déjà construits : le MCP est une **façade**,
 * pas un étage de logique. Son fichier de régulation par défaut est celui de la
 * régulation elle-même, pour que `get_regulation_config` réponde toujours avec le
 * fichier qui a réellement produit les décisions.
 */
async function startMcp(
  options: CoreOptions,
  mirror: Mirror,
  journal: Journal,
  bus: Bus,
  logger: Logger,
): Promise<McpHttpServer | null> {
  const settings = options.mcp;
  if (settings?.enabled === false) return null;

  const regulationConfigPath = settings?.regulationConfigPath ?? options.regulation?.configPath;
  const mcp = await startMcpServer({
    mirror,
    journal,
    bus,
    logger,
    port: settings?.port ?? CORE_MCP_DEFAULT_PORT,
    ...(settings?.host !== undefined ? { host: settings.host } : {}),
    ...(regulationConfigPath !== undefined ? { regulationConfigPath } : {}),
  });
  logger.info('serveur MCP actif', { url: mcp.url });
  return mcp;
}

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

  const regulation = await startRegulation(options, mirror, bus, logger);

  const api =
    options.apiPort === null || options.apiPort === undefined
      ? null
      : await startApiServer({
          mirror,
          journal,
          port: options.apiPort,
          ...(options.apiHost !== undefined ? { host: options.apiHost } : {}),
        });

  const mcp = await startMcp(options, mirror, journal, bus, logger);

  return {
    mirror,
    journal,
    staleWatcher,
    api,
    regulation,
    mcp,
    async close() {
      regulation?.close();
      staleWatcher.close();
      await mcp?.close();
      await api?.close();
      // Le bus n'appartient pas au core : c'est l'appelant qui le ferme, et il doit
      // le faire AVANT (un message arrivant après `journal.close()` ne serait plus
      // journalisé — l'erreur est rattrapée, mais le fait serait perdu).
      journal.close();
    },
  };
}
