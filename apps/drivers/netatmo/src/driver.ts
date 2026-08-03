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
import type { NetatmoApiLike } from './api.js';
import { AUTH_DEAD_MESSAGE, AuthDeadError } from './auth.js';
import {
  buildStationPercepts,
  buildThermostatPercepts,
  buildThermostatTopology,
  type Percept,
  type ThermostatTopology,
} from './mapping.js';

export const DRIVER_NAME = 'netatmo';
export const DRIVER_VERSION = '0.1.0';

/**
 * Nombre de cycles de polling ratés d'affilée avant de marquer les entités
 * `stale` (ADR-009). Deux : un hoquet du cloud Netatmo ne doit pas faire clignoter
 * tout le bus, mais deux minutes de silence sur un thermostat, ça se dit.
 * Une authentification morte, elle, marque `stale` **immédiatement** : il n'y a
 * rien à attendre, seul un humain peut débloquer.
 */
export const STALE_AFTER_FAILURES = 2;

/**
 * Paramètres de `set`. Bornes 5–30 °C : celles du thermostat Netatmo (hors-gel à
 * 7 °C, maximum 30 °C). Le driver refuse ce que l'API refuserait — et rien de
 * plus : décider *quelle* consigne appliquer est le travail du core (interdit n°1).
 */
export const SetParams = z
  .object({
    targetTemp: z.number().min(5).max(30).optional(),
    mode: z.enum(['heat', 'auto']).optional(),
  })
  .strict()
  .refine(
    (params) => params.targetTemp !== undefined || params.mode !== undefined,
    'au moins un de targetTemp, mode est requis',
  )
  .refine(
    (params) => !(params.mode === 'auto' && params.targetTemp !== undefined),
    'mode « auto » et targetTemp sont contradictoires : le programme du thermostat écraserait la consigne',
  );
export type SetParams = z.infer<typeof SetParams>;

export interface NetatmoDriverOptions {
  bus: Bus;
  api: NetatmoApiLike;
  logger: Logger;
  /** Spec §9 : 1–2 min thermostat, 5 min météo. Réduits à ~50 ms dans les tests. */
  thermostatIntervalMs?: number;
  stationIntervalMs?: number;
  /** Âge au-delà duquel une mesure de station est publiée `stale`. */
  stationFreshnessMs?: number;
}

export interface NetatmoDriverHandle {
  /** Authentification morte : réauthentification manuelle nécessaire (spec §9). */
  readonly authDead: boolean;
  /** Cloud Netatmo joignable ET authentifié — faux dès que des entités sont `stale`. */
  readonly reachable: boolean;
  readonly percepts: readonly Percept[];
  readonly topology: ThermostatTopology | null;
  /** Exposés pour l'outillage et les tests — les boucles les appellent périodiquement. */
  pollThermostat(): Promise<void>;
  pollStation(): Promise<void>;
  close(): void;
}

export function buildManifest(
  topology: ThermostatTopology | null,
  stationPercepts: readonly Percept[],
): Manifest {
  const entities: EntityDecl[] = [
    // Les thermostats viennent de l'inventaire, pas des percepts : leur déclaration
    // ne doit pas disparaître du manifeste parce qu'un cycle a échoué.
    ...(topology?.rooms ?? []).map((room) => ({
      id: room.entityId,
      kind: 'climate' as const,
      room: room.room,
    })),
    ...stationPercepts.map((percept) => ({
      id: percept.entityId,
      kind: percept.kind,
      ...(percept.room === undefined ? {} : { room: percept.room }),
      ...(percept.unit === undefined ? {} : { unit: percept.unit }),
    })),
  ];
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities,
    commands: [{ action: 'set', paramsSchema: toJsonSchema(SetParams) }],
  };
}

/**
 * Traducteur pur : polling Netatmo → entités retained, commandes du bus → écritures
 * API. Aucune décision ici (interdit n°1) — le driver ne choisit ni consigne ni
 * moment, il traduit.
 *
 * Deux cadences (spec §9, rate limits Netatmo) : le thermostat toutes les ~90 s,
 * la station toutes les ~5 min. Les deux boucles sont indépendantes : une station
 * muette ne doit pas rendre le thermostat suspect, et réciproquement.
 */
export async function startNetatmoDriver(
  options: NetatmoDriverOptions,
): Promise<NetatmoDriverHandle> {
  const { bus, api, logger } = options;
  const thermostatIntervalMs = options.thermostatIntervalMs ?? 90_000;
  const stationIntervalMs = options.stationIntervalMs ?? 300_000;

  let topology: ThermostatTopology | null = null;
  let thermPercepts: Percept[] = [];
  let stationPercepts: Percept[] = [];
  let thermFailures = 0;
  let stationFailures = 0;
  let thermStale = false;
  let stationStale = false;
  let authDead = false;
  let thermBusy = false;
  let stationBusy = false;
  let announced = '';
  let closed = false;

  const toEntity = (percept: Percept, stale: boolean): Entity => ({
    id: percept.entityId,
    driver: DRIVER_NAME,
    kind: percept.kind,
    ...(percept.room === undefined ? {} : { room: percept.room }),
    ...(percept.unit === undefined ? {} : { unit: percept.unit }),
    value: percept.value,
    ts: new Date().toISOString(),
    ...(stale || percept.stale === true ? { stale: true } : {}),
  });

  /** Une publication ratée ne doit ni tuer le driver ni passer inaperçue. */
  const publishAll = async (percepts: readonly Percept[], stale: boolean): Promise<void> => {
    await Promise.all(
      percepts.map((percept) =>
        bus.publishState(toEntity(percept, stale)).catch((err: unknown) =>
          logger.warn('publication state échouée', {
            entityId: percept.entityId,
            error: String(err),
          }),
        ),
      ),
    );
  };

  const announceIfChanged = async (): Promise<void> => {
    const manifest = buildManifest(topology, stationPercepts);
    const serialized = JSON.stringify(manifest);
    if (serialized === announced) return;
    announced = serialized;
    await bus.announce(manifest);
  };

  /**
   * Un cycle raté. Au-delà du seuil (ou dès qu'on sait l'auth morte), les entités
   * du périmètre concerné repartent sur le bus avec `stale: true` — une seule
   * fois, tant que la panne dure : republier à chaque échec n'apprendrait rien.
   */
  const onFailure = async (
    scope: 'thermostat' | 'station',
    err: unknown,
    percepts: readonly Percept[],
  ): Promise<void> => {
    const dead = err instanceof AuthDeadError;
    if (dead) authDead = true;
    const failures = scope === 'thermostat' ? (thermFailures += 1) : (stationFailures += 1);
    const alreadyStale = scope === 'thermostat' ? thermStale : stationStale;
    const nowStale = dead || failures >= STALE_AFTER_FAILURES;

    logger[dead ? 'error' : 'warn']('cycle de polling échoué', {
      scope,
      failures,
      authDead: dead,
      error: err instanceof Error ? err.message : String(err),
    });

    if (!nowStale || alreadyStale) return;
    if (scope === 'thermostat') thermStale = true;
    else stationStale = true;
    logger.warn('équipement muet, entités marquées stale (ADR-009)', { scope });
    await publishAll(percepts, true);
  };

  const pollThermostat = async (): Promise<void> => {
    if (thermBusy || closed) return;
    thermBusy = true;
    try {
      if (topology === null) {
        topology = buildThermostatTopology(await api.getHomesData(), logger);
        if (topology === null) {
          logger.warn('aucun thermostat NATherm1 dans le compte Netatmo');
          return;
        }
        logger.info('inventaire thermostat', {
          home: topology.homeName,
          rooms: topology.rooms.map((room) => room.entityId),
        });
      }
      const status = await api.getHomeStatus(topology.homeId);
      thermPercepts = buildThermostatPercepts(status, topology, logger);
      thermFailures = 0;
      thermStale = false;
      authDead = false;
      await publishAll(thermPercepts, false);
      await announceIfChanged();
    } catch (err) {
      await onFailure('thermostat', err, thermPercepts);
    } finally {
      thermBusy = false;
    }
  };

  const pollStation = async (): Promise<void> => {
    if (stationBusy || closed) return;
    stationBusy = true;
    try {
      const stations = await api.getStationsData();
      stationPercepts = buildStationPercepts(stations, {
        logger,
        ...(options.stationFreshnessMs === undefined
          ? {}
          : { freshnessMs: options.stationFreshnessMs }),
      });
      stationFailures = 0;
      stationStale = false;
      authDead = false;
      await publishAll(stationPercepts, false);
      await announceIfChanged();
    } catch (err) {
      await onFailure('station', err, stationPercepts);
    } finally {
      stationBusy = false;
    }
  };

  await bus.onCommand(async (cmd: Command): Promise<Ack> => {
    const rejected = (reason: string): Ack => ({ commandId: cmd.id, status: 'rejected', reason });
    const room = topology?.rooms.find((candidate) => candidate.entityId === cmd.target);
    if (topology === null || room === undefined) return rejected(`entité inconnue: ${cmd.target}`);
    if (cmd.action !== 'set') return rejected(`action inconnue: ${cmd.action}`);

    const params = SetParams.safeParse(cmd.params);
    if (!params.success)
      return rejected(params.error.issues.map((issue) => issue.message).join('; '));
    // Auth morte : on sait ne pas pouvoir transmettre, donc jamais d'ack `ok` (ADR-009).
    if (authDead) return rejected(AUTH_DEAD_MESSAGE);

    try {
      if (params.data.mode === 'auto') {
        // Retour au programme : c'est un mode *de maison* chez Netatmo, pas de pièce.
        await api.setThermMode({ homeId: topology.homeId, mode: 'schedule' });
      } else {
        // `manual` exige une température : à défaut, la consigne courante — sans
        // elle on ne peut rien envoyer d'honnête.
        const current = thermPercepts.find((percept) => percept.entityId === cmd.target)?.value as
          { targetTemp?: number } | undefined;
        const temp = params.data.targetTemp ?? current?.targetTemp;
        if (temp === undefined) {
          return rejected('consigne courante inconnue: préciser targetTemp');
        }
        await api.setRoomThermPoint({
          homeId: topology.homeId,
          roomId: room.roomId,
          mode: 'manual',
          temp,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('commande refusée par l’API Netatmo', { entityId: cmd.target, reason });
      return rejected(reason);
    }

    // Ack = accusé de *transmission* (l'API a répondu `status: ok`). L'état, lui,
    // vient du prochain `homestatus` — qu'on déclenche tout de suite.
    void pollThermostat().catch((err: unknown) =>
      logger.warn('poll post-commande échoué', { error: String(err) }),
    );
    return { commandId: cmd.id, status: 'ok' };
  });

  await bus.announce(buildManifest(null, []));
  // Premier passage immédiat : le bus doit avoir un état avant la première période.
  await Promise.all([pollThermostat(), pollStation()]);

  const thermTimer = setInterval(() => void pollThermostat(), thermostatIntervalMs);
  const stationTimer = setInterval(() => void pollStation(), stationIntervalMs);

  const handle: NetatmoDriverHandle = {
    get authDead() {
      return authDead;
    },
    get reachable() {
      return !authDead && !thermStale && !stationStale;
    },
    get percepts() {
      return [...thermPercepts, ...stationPercepts];
    },
    get topology() {
      return topology;
    },
    pollThermostat,
    pollStation,
    close() {
      closed = true;
      clearInterval(thermTimer);
      clearInterval(stationTimer);
    },
  };

  logger.info('driver netatmo prêt', {
    thermostats: handle.topology?.rooms.length ?? 0,
    entities: handle.percepts.length,
    thermostatIntervalMs,
    stationIntervalMs,
  });
  return handle;
}
