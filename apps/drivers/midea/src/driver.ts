import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import {
  toJsonSchema,
  type Ack,
  type Command,
  type Entity,
  type EntityDecl,
  type Manifest,
} from '@stellar/contracts';
import {
  climatePatchToStatus,
  createSk103Appliance,
  isUnreachable,
  statusToClimateValue,
  type MideaApplianceLike,
  type MideaStatus,
} from '@stellar/midea-protocol';
import type { MideaUnit, MideaUnits } from './config.js';

export const DRIVER_NAME = 'midea';
export const DRIVER_VERSION = '0.1.0';

/**
 * Paramètres de `set`. Bornes 16–31 °C : celles que `setStatus` de node-mideahvac
 * accepte en Celsius (`lib/ac.js`). Le driver refuse ce que l'unité refuserait — et
 * rien de plus : décider *quelle* consigne appliquer est le travail du core
 * (interdit n°1, spec §4).
 *
 * `fan` reste une chaîne libre (`auto`, `silent`, `low`, `medium`, `high` ou un
 * pourcentage `0`–`100`) : c'est le mapping du protocole qui connaît le vocabulaire
 * de l'équipement, pas le contrat du bus.
 */
export const SetParams = z
  .object({
    power: z.boolean().optional(),
    mode: z.enum(['auto', 'cool', 'dry', 'heat', 'fan']).optional(),
    targetTemp: z.number().min(16).max(31).optional(),
    fan: z.string().optional(),
  })
  .strict()
  .refine(
    (params) => Object.values(params).some((value) => value !== undefined),
    'au moins un de power, mode, targetTemp, fan est requis',
  );
export type SetParams = z.infer<typeof SetParams>;

/** Amplitude du jitter appliqué à la période de polling : ±10 %. */
export const JITTER_RATIO = 0.1;

/**
 * Seuil « injoignable > 5 min » (spec §9) exprimé en **cycles de polling ratés
 * consécutifs** : `ceil(staleAfterMs / pollMs)`, jamais moins de 2.
 *
 * Le compteur de cycles plutôt qu'une horloge : le driver ne fait rien d'autre
 * qu'attendre entre deux polls, donc « n cycles » et « n × pollMs » disent la même
 * chose sans horloge à injecter ni dérive à gérer. Par défaut :
 * `ceil(300 000 / 45 000) = 7` cycles ≈ 5 min 15 s — au-delà des 5 min demandées,
 * ce qui est le bon côté de l'erreur pour une alerte.
 *
 * Le plancher à 2 est le vrai garde-fou : **un échec isolé n'est pas une panne**.
 * Un SK103 rate un poll de temps en temps ; faire clignoter le bus à chaque hoquet
 * rendrait l'information `stale` inutilisable par la régulation (P6).
 */
export function staleAfterCycles(staleAfterMs: number, pollMs: number): number {
  return Math.max(2, Math.ceil(staleAfterMs / pollMs));
}

/**
 * Identifiant du percept de température d'une unité. La sonde est celle de la
 * clim, **en haut du mur** : elle lit systématiquement plus chaud que la pièce en
 * chauffage et plus froid en clim. C'est un fallback assumé (spec §9 : « approximatif
 * […] sert de fallback avant/en complément des capteurs Zigbee » de P5), pas une
 * mesure de référence — la régulation P6 lui préférera `temp_<room>` s'il existe.
 */
export const temperatureIdOf = (unit: MideaUnit): string => `temp_${unit.room}_clim`;

export type ApplianceFactory = (unit: MideaUnit) => MideaApplianceLike;

/** Fabrique de production : le vrai transport LAN chiffré (ADR-005). */
export const defaultApplianceFactory: ApplianceFactory = (unit) =>
  createSk103Appliance({ host: unit.host, id: unit.id, token: unit.token, key: unit.key });

export interface MideaDriverOptions {
  bus: Bus;
  units: MideaUnits;
  logger: Logger;
  /** Spec §9 : 30–60 s. Réduit à quelques dizaines de ms dans les tests. */
  pollMs?: number;
  /** Spec §9 : 5 min. Réduit dans les tests pour ne pas attendre 5 minutes. */
  staleAfterMs?: number;
  /** Couture ADR-010 : le fake du protocole prend la place du dongle en test. */
  createAppliance?: ApplianceFactory;
  /** Injectable pour rendre le jitter déterministe si besoin. */
  random?: () => number;
}

/** Vue en lecture seule d'une unité — outillage, tests, diagnostic. */
export interface UnitView {
  readonly entityId: string;
  readonly room: string;
  readonly temperatureId: string;
  readonly stale: boolean;
  readonly failures: number;
  readonly status: MideaStatus | null;
  /** Historique des délais planifiés (jitter) — borné, sert au diagnostic. */
  readonly delays: readonly number[];
}

export interface MideaDriverHandle {
  readonly units: readonly UnitView[];
  /** Nombre de cycles ratés consécutifs avant `stale` (cf. `staleAfterCycles`). */
  readonly staleAfterCycles: number;
  /** Exposé pour l'outillage et les tests — la boucle l'appelle périodiquement. */
  poll(entityId: string): Promise<void>;
  close(): void;
}

interface UnitState {
  readonly unit: MideaUnit;
  readonly appliance: MideaApplianceLike;
  readonly temperatureId: string;
  status: MideaStatus | null;
  failures: number;
  stale: boolean;
  busy: boolean;
  timer: NodeJS.Timeout | null;
  delays: number[];
}

const MAX_DELAY_HISTORY = 20;

export function buildManifest(units: MideaUnits): Manifest {
  const entities: EntityDecl[] = units.flatMap((unit): EntityDecl[] => [
    { id: unit.entityId, kind: 'climate', room: unit.room },
    { id: temperatureIdOf(unit), kind: 'temperature', room: unit.room, unit: '°C' },
  ]);
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities,
    commands: [{ action: 'set', paramsSchema: toJsonSchema(SetParams) }],
  };
}

/**
 * Traducteur pur : polling doux des unités Midea → entités retained, commandes du
 * bus → écritures sur l'unité. Aucune décision ici (interdit n°1).
 *
 * Une boucle **indépendante par unité** : trois dongles sur trois clims, dont
 * chacun peut décrocher seul. Une clim muette ne doit rendre suspectes ni les deux
 * autres ni la régulation des autres pièces.
 */
export async function startMideaDriver(options: MideaDriverOptions): Promise<MideaDriverHandle> {
  const { bus, logger } = options;
  const pollMs = options.pollMs ?? 45_000;
  const staleAfterMs = options.staleAfterMs ?? 300_000;
  const createAppliance = options.createAppliance ?? defaultApplianceFactory;
  const random = options.random ?? Math.random;
  const staleThreshold = staleAfterCycles(staleAfterMs, pollMs);

  let closed = false;

  const states: UnitState[] = options.units.map((unit) => ({
    unit,
    appliance: createAppliance(unit),
    temperatureId: temperatureIdOf(unit),
    status: null,
    failures: 0,
    stale: false,
    busy: false,
    timer: null,
    delays: [],
  }));

  const now = (): string => new Date().toISOString();

  /**
   * Une unité publie **deux** entités (spec §9) : l'actionneur `climate` et le
   * percept `temperature`. Le percept est omis tant que l'unité n'a pas rapporté
   * de sonde — publier une T° inventée serait pire que ne rien publier.
   */
  const entitiesOf = (state: UnitState, stale: boolean): Entity[] => {
    if (state.status === null) return [];
    const ts = now();
    const staleFlag = stale ? { stale: true } : {};
    const entities: Entity[] = [
      {
        id: state.unit.entityId,
        driver: DRIVER_NAME,
        kind: 'climate',
        room: state.unit.room,
        value: statusToClimateValue(state.status),
        ts,
        ...staleFlag,
      },
    ];
    if (state.status.indoorTemperature !== undefined) {
      entities.push({
        id: state.temperatureId,
        driver: DRIVER_NAME,
        kind: 'temperature',
        room: state.unit.room,
        value: state.status.indoorTemperature,
        unit: '°C',
        ts,
        ...staleFlag,
      });
    }
    return entities;
  };

  /** Une publication ratée ne doit ni tuer le driver ni passer inaperçue. */
  const publish = async (state: UnitState, stale: boolean): Promise<void> => {
    let entities: Entity[];
    try {
      entities = entitiesOf(state, stale);
    } catch (err) {
      // Mapping impossible (mode inconnu du firmware) : on jette, on loggue.
      logger.warn('statut Midea intraduisible, publication abandonnée', {
        entityId: state.unit.entityId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await Promise.all(
      entities.map((entity) =>
        bus.publishState(entity).catch((err: unknown) =>
          logger.warn('publication state échouée', {
            entityId: entity.id,
            error: String(err),
          }),
        ),
      ),
    );
  };

  const onSuccess = async (state: UnitState, status: MideaStatus): Promise<void> => {
    const wasStale = state.stale;
    state.status = status;
    state.failures = 0;
    state.stale = false;
    if (wasStale) {
      logger.info('unité de nouveau joignable, resynchronisation (ADR-009)', {
        entityId: state.unit.entityId,
      });
    }
    await publish(state, false);
  };

  /**
   * Cycle raté. Au-delà du seuil, les **deux** entités de l'unité repartent sur le
   * bus avec `stale: true` — une seule fois tant que la panne dure : republier à
   * chaque échec n'apprendrait rien à personne.
   */
  const onFailure = async (state: UnitState, err: unknown): Promise<void> => {
    state.failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('cycle de polling échoué', {
      entityId: state.unit.entityId,
      failures: state.failures,
      error: message,
    });
    if (state.stale || state.failures < staleThreshold) return;
    state.stale = true;
    logger.error('unité injoignable, entités marquées stale (ADR-009)', {
      entityId: state.unit.entityId,
      temperatureId: state.temperatureId,
      failures: state.failures,
      thresholdCycles: staleThreshold,
      approxSilenceMs: state.failures * pollMs,
    });
    await publish(state, true);
  };

  const pollState = async (state: UnitState): Promise<void> => {
    if (state.busy || closed) return;
    state.busy = true;
    try {
      await onSuccess(state, await state.appliance.getStatus());
    } catch (err) {
      await onFailure(state, err);
    } finally {
      state.busy = false;
    }
  };

  /**
   * Jitter ±10 % : sans lui, trois unités démarrées ensemble se retrouveraient
   * pollées à la milliseconde près pendant des jours. Trois dongles SK103 qui
   * parlent en même temps sur le même WiFi, c'est exactement le genre de rafale
   * qui les fait décrocher (spec §9).
   */
  const nextDelay = (): number =>
    Math.max(1, Math.round(pollMs * (1 - JITTER_RATIO + random() * 2 * JITTER_RATIO)));

  const schedule = (state: UnitState): void => {
    if (closed) return;
    if (state.timer !== null) clearTimeout(state.timer);
    const delay = nextDelay();
    state.delays.push(delay);
    if (state.delays.length > MAX_DELAY_HISTORY) state.delays.shift();
    state.timer = setTimeout(() => {
      void pollState(state).finally(() => {
        schedule(state);
      });
    }, delay);
    state.timer.unref?.();
  };

  const byEntityId = new Map(states.map((state) => [state.unit.entityId, state]));

  await bus.onCommand(async (cmd: Command): Promise<Ack> => {
    const rejected = (reason: string): Ack => ({ commandId: cmd.id, status: 'rejected', reason });
    const state = byEntityId.get(cmd.target);
    if (state === undefined) return rejected(`entité inconnue: ${cmd.target}`);
    if (cmd.action !== 'set') return rejected(`action inconnue: ${cmd.action}`);

    const params = SetParams.safeParse(cmd.params);
    if (!params.success) {
      return rejected(params.error.issues.map((issue) => issue.message).join('; '));
    }
    // On sait ne pas pouvoir transmettre : jamais d'ack `ok` (ADR-009).
    if (state.stale) return rejected(`unité injoignable: ${cmd.target}`);

    let patch;
    try {
      patch = climatePatchToStatus(params.data);
    } catch (err) {
      return rejected(err instanceof Error ? err.message : String(err));
    }

    let status: MideaStatus;
    try {
      status = await state.appliance.setStatus(patch);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isUnreachable(err)) {
        // Une commande perdue vaut un cycle raté : elle compte dans le seuil stale.
        await onFailure(state, err);
      } else {
        logger.warn('commande refusée par l’unité Midea', { entityId: cmd.target, reason });
      }
      return rejected(reason);
    }

    // `setStatus` rend l'état **après** application : c'est une resynchronisation
    // gratuite, on la publie tout de suite plutôt que d'attendre le prochain poll.
    await onSuccess(state, status);
    // Anti-martèlement : la commande vient de parler à l'unité, le prochain poll
    // repart d'une période complète. Sans ça, une rafale de commandes doublerait
    // le trafic vers un dongle qu'on cherche justement à ménager.
    schedule(state);
    return { commandId: cmd.id, status: 'ok' };
  });

  await bus.announce(buildManifest(options.units));

  // Poignée de main puis première publication : le bus doit avoir un état avant la
  // première période. `connect()` amorce l'état interne de la lib, sans lequel
  // `setStatus` construirait sa trame à partir d'un statut vide.
  await Promise.all(
    states.map(async (state) => {
      try {
        await state.appliance.connect();
      } catch (err) {
        await onFailure(state, err);
        return;
      }
      await pollState(state);
    }),
  );

  for (const state of states) schedule(state);

  const handle: MideaDriverHandle = {
    get units() {
      return states.map((state): UnitView => ({
        entityId: state.unit.entityId,
        room: state.unit.room,
        temperatureId: state.temperatureId,
        stale: state.stale,
        failures: state.failures,
        status: state.status,
        delays: [...state.delays],
      }));
    },
    staleAfterCycles: staleThreshold,
    async poll(entityId) {
      const state = byEntityId.get(entityId);
      if (state === undefined) throw new Error(`entité inconnue: ${entityId}`);
      await pollState(state);
    },
    close() {
      closed = true;
      for (const state of states) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.appliance.disconnect();
      }
    },
  };

  logger.info('driver midea prêt', {
    units: states.length,
    pollMs,
    jitterRatio: JITTER_RATIO,
    staleAfterCycles: staleThreshold,
    staleAfterMs,
  });
  return handle;
}
