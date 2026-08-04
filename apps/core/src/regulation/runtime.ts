import { randomUUID } from 'node:crypto';
import type { Bus, Logger } from '@stellar/bus';
import type { Command, Kind } from '@stellar/contracts';
import { Kind as KindEnum } from '@stellar/contracts';
import type { Mirror } from '../mirror.js';
import { decide } from './decide.js';
import type { RegulationConfig } from './regulation-config.js';
import { buildSnapshot } from './snapshot.js';
import { isPowerToggle, type Decision, type Outcome } from './types.js';

/**
 * Partie **branchée** de la régulation : elle construit l'instantané, appelle la
 * fonction pure `decide`, puis exécute ce qu'elle a rendu.
 *
 * Tout ce qui est délicat (choix, seuils, hystérésis) est dans `decide` et se
 * teste sans broker ; ici il ne reste que de la plomberie : un timer, des
 * déclencheurs, l'envoi des commandes et la publication des événements.
 *
 * Deux invariants tiennent tout :
 *
 * - **le driver destinataire vient du miroir** (`entity.driver`, ADR-008) — la
 *   régulation n'écrit jamais un nom de driver ;
 * - **la mémoire vit ici** (délestage en cours, alertes déjà criées, date de la
 *   dernière bascule de chaque actionneur) et retraverse `decide` à chaque tour.
 */

/** `home/event/core/regulation` — data de l'événement publié à chaque décision. */
export interface RegulationEventData {
  /** Pièce concernée, ou `maison` pour les décisions globales (délestage). */
  room: string;
  decision: string;
  cause: string;
  /**
   * Présent uniquement quand la commande émise n'a PAS été acquittée `ok` :
   * le journal doit permettre de relire aussi ce que le matériel a refusé
   * (DoD P6 — une décision sans effet est une information, pas un détail).
   */
  commandFailure?: { status: 'rejected' | 'timeout'; reason?: string };
}

export const REGULATION_EVENT_TYPE = 'regulation';

/** Kinds dont un changement peut modifier une décision → réévaluation immédiate. */
const TRIGGER_KINDS: readonly Kind[] = [
  'temperature',
  'presence',
  'climate',
  'power',
  KindEnum.enum.tempo,
];

export interface RegulationOptions {
  mirror: Mirror;
  bus: Bus;
  logger: Logger;
  config: RegulationConfig;
  /** Horloge injectable (tests). Défaut `Date.now`. */
  clock?: () => number;
  /** Défaut 60 s (spec §10 : un thermostat n'a pas besoin de temps réel). */
  evaluateIntervalMs?: number;
  /**
   * Regroupement des déclenchements sur changement d'état : une rafale de
   * publications (le compteur, les trois clims) ne doit produire qu'un tour.
   */
  triggerDebounceMs?: number;
  /** Timeout des commandes émises. Défaut 5 s (celui du bus). */
  commandTimeoutMs?: number;
}

export interface Regulation {
  /** Un tour complet. Appelé par le timer et les déclencheurs, exposé aux tests. */
  evaluate(): Promise<Outcome>;
  /** Dernier résultat calculé (introspection, tests). */
  readonly lastOutcome: Outcome | undefined;
  close(): void;
}

export async function createRegulation(options: RegulationOptions): Promise<Regulation> {
  const { mirror, bus, logger, config } = options;
  const clock = options.clock ?? Date.now;
  const intervalMs = options.evaluateIntervalMs ?? 60_000;
  const debounceMs = options.triggerDebounceMs ?? 500;

  let shed: string[] = [];
  let alerts: string[] = [];
  const lastPowerChangeAt: Record<string, number> = {};
  let lastOutcome: Outcome | undefined;

  let closed = false;
  let running = false;
  let rerun = false;
  let debounce: NodeJS.Timeout | undefined;

  const publish = async (
    decision: Decision,
    ts: string,
    commandFailure?: RegulationEventData['commandFailure'],
  ): Promise<void> => {
    await bus.publishEvent({
      driver: 'core',
      type: REGULATION_EVENT_TYPE,
      data: {
        room: decision.room,
        decision: decision.decision,
        cause: decision.cause,
        ...(commandFailure ? { commandFailure } : {}),
      } satisfies RegulationEventData,
      ts,
    });
  };

  const apply = async (decision: Decision, now: number): Promise<void> => {
    const ts = new Date(now).toISOString();

    if (decision.command) {
      // ADR-008 : le driver destinataire est une donnée du miroir, jamais un nom
      // écrit dans le core. Entité inconnue ⇒ rien n'est envoyé.
      const entity = mirror.getState(decision.command.target);
      if (!entity) {
        logger.warn('décision sans destinataire : entité absente du miroir', {
          target: decision.command.target,
          decision: decision.decision,
        });
        return;
      }
      const command: Command = {
        id: randomUUID(),
        target: decision.command.target,
        action: decision.command.action,
        params: decision.command.params,
        issuedBy: 'core',
        ts,
      };
      // La bascule est comptabilisée à l'**émission** : un ack perdu ne doit pas
      // autoriser une nouvelle tentative au tour suivant (ce serait l'oscillation
      // que l'anti-court-cycle interdit).
      if (isPowerToggle(decision.command)) lastPowerChangeAt[decision.command.target] = now;

      const ack = await bus.sendCommand(command, {
        driver: entity.driver,
        ...(options.commandTimeoutMs !== undefined ? { timeoutMs: options.commandTimeoutMs } : {}),
      });
      if (ack.status !== 'ok') {
        logger.warn('commande de régulation non acquittée', {
          target: command.target,
          decision: decision.decision,
          status: ack.status,
          reason: ack.reason,
        });
        // L'échec part aussi dans l'événement (donc dans le journal) : un
        // opérateur qui relit home/event/# doit voir que le matériel a refusé.
        await publish(decision, ts, {
          status: ack.status,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        });
        logger.info('décision de régulation', {
          room: decision.room,
          decision: decision.decision,
          cause: decision.cause,
        });
        return;
      }
    }

    // La décision est publiée même si la commande a échoué : le DoD P6 demande de
    // relire ce que le core a **décidé**, l'ack raconte ce que le matériel en a fait.
    await publish(decision, ts);
    logger.info('décision de régulation', {
      room: decision.room,
      decision: decision.decision,
      cause: decision.cause,
    });
  };

  const evaluate = async (): Promise<Outcome> => {
    const now = clock();
    const snapshot = buildSnapshot({ mirror, config, shed, alerts, lastPowerChangeAt });
    const outcome = decide(snapshot, config, now);

    shed = outcome.shed;
    alerts = outcome.alerts;
    lastOutcome = outcome;

    for (const decision of outcome.decisions) {
      if (decision.severity === 'blocked') {
        logger.debug('décision empêchée', {
          room: decision.room,
          decision: decision.decision,
          cause: decision.cause,
        });
        continue;
      }
      await apply(decision, now);
    }

    return outcome;
  };

  /** Une seule évaluation à la fois ; un déclencheur pendant un tour en relance un. */
  const run = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        await evaluate();
      } while (rerun && !closed);
    } finally {
      running = false;
    }
  };

  const safeRun = (): void => {
    void run().catch((err: unknown) =>
      logger.error('échec d’un tour de régulation', { error: String(err) }),
    );
  };

  const trigger = (): void => {
    if (closed || debounce !== undefined) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      safeRun();
    }, debounceMs);
    debounce.unref();
  };

  // Sélecteurs uniquement (règle n°7). Toutes ces souscriptions retombent sur le
  // filtre `home/state/#`, déjà posé par le miroir : aucune livraison en double,
  // donc aucune entrée de journal dupliquée (cf. JOURNAL_FILTERS dans core.ts).
  for (const kind of TRIGGER_KINDS) {
    await bus.onState({ kind }, trigger);
  }

  const timer = setInterval(safeRun, intervalMs);
  // La régulation ne doit pas, à elle seule, maintenir le process en vie.
  timer.unref();

  return {
    evaluate,
    get lastOutcome() {
      return lastOutcome;
    },
    close() {
      closed = true;
      clearInterval(timer);
      if (debounce !== undefined) clearTimeout(debounce);
    },
  };
}
