import { Kind, isKind, type Entity } from '@stellar/contracts';
import type { Mirror } from '../mirror.js';
import type { OccupancyProfile } from '../predictive/occupancy.js';
import type { RegulationConfig } from './regulation-config.js';
import type {
  ActuatorRole,
  ActuatorState,
  PowerSnapshot,
  PresenceReading,
  RoomSnapshot,
  SensorReading,
  Snapshot,
  TempoSnapshot,
} from './types.js';

/**
 * Extraction du miroir vers l'instantané que consomme `decide`.
 *
 * C'est la seule couche qui touche au miroir, et elle n'y touche **que par
 * sélecteurs** (`kind` + `room`) ou par `entityId` venu de la configuration :
 * aucun nom de driver n'apparaît (spec règle n°7). Le `driver` d'une entité,
 * nécessaire au transport, est résolu au moment de l'envoi par le runtime
 * (ADR-008), pas ici.
 *
 * Aucune décision n'est prise ici : on traduit, on ne juge pas.
 */

/** Le kind `tempo` par la valeur de l'enum : jamais le littéral (règle ESLint). */
const TEMPO_KIND = Kind.enum.tempo;

export interface SnapshotSources {
  mirror: Mirror;
  config: RegulationConfig;
  shed: readonly string[];
  alerts: readonly string[];
  lastPowerChangeAt: Readonly<Record<string, number>>;
  /**
   * Profil d'occupation (P9). Il ne vient PAS du miroir — le miroir ne connaît
   * que le présent — mais du journal, agrégé par le runtime. Il traverse ici pour
   * que `decide` reste une fonction pure d'un seul instantané.
   */
  occupancy?: OccupancyProfile;
}

/** Ordre stable quand plusieurs entités du même kind existent (déterminisme). */
const byId = (a: Entity, b: Entity): number => a.id.localeCompare(b.id);

export function buildSnapshot(sources: SnapshotSources): Snapshot {
  const { mirror, config } = sources;
  const health = mirror.getHealth();

  /**
   * Un driver absent du registre est considéré **en ligne** : le health est
   * retained, son absence signifie « jamais vu », pas « mort ». La preuve qu'il
   * a parlé, c'est l'entité elle-même dans le miroir — et sa fraîcheur est déjà
   * couverte par `stale` (ADR-009 + veille du core).
   */
  const driverOnline = (driver: string): boolean => health.get(driver)?.status !== 'offline';

  /** `stale` du contrat, élargi au cas « le process qui publie est mort ». */
  const isStale = (entity: Entity): boolean =>
    entity.stale === true || !driverOnline(entity.driver);

  const readActuator = (entityId: string, role: ActuatorRole): ActuatorState => {
    const entity = mirror.getState(entityId);
    if (!entity || !isKind(entity, 'climate')) {
      return {
        entityId,
        role,
        known: false,
        stale: true,
        driverOnline: false,
        power: false,
        mode: 'heat',
        targetTemp: 0,
      };
    }
    return {
      entityId,
      role,
      known: true,
      stale: entity.stale === true,
      driverOnline: driverOnline(entity.driver),
      power: entity.value.power,
      mode: entity.value.mode,
      targetTemp: entity.value.targetTemp,
      ...(entity.value.indoorTemp !== undefined ? { indoorTemp: entity.value.indoorTemp } : {}),
    };
  };

  const readSensor = (entityId: string): SensorReading => {
    const entity = mirror.getState(entityId);
    // Entité absente ou d'un autre kind : inexploitable, donc `stale`. La valeur
    // n'est jamais lue dans ce cas — `NaN` est là pour que ça se voie si ça arrive.
    if (!entity || !isKind(entity, 'temperature')) {
      return { entityId, value: Number.NaN, stale: true };
    }
    return { entityId, value: entity.value, stale: isStale(entity) };
  };

  const readPresence = (room: string): PresenceReading[] =>
    mirror
      .getStates({ kind: 'presence', room })
      .sort(byId)
      .flatMap((entity) =>
        isKind(entity, 'presence')
          ? [
              {
                entityId: entity.id,
                value: entity.value,
                ts: Date.parse(entity.ts),
                stale: isStale(entity),
              },
            ]
          : [],
      );

  const rooms: RoomSnapshot[] = Object.entries(config.rooms).map(([room, roomConfig]) => ({
    room,
    sensors: roomConfig.sensors.map(readSensor),
    presence: readPresence(room),
    ...(roomConfig.actuators.pac !== undefined
      ? { pac: readActuator(roomConfig.actuators.pac, 'pac') }
      : {}),
    ...(roomConfig.actuators.central !== undefined
      ? { central: readActuator(roomConfig.actuators.central, 'central') }
      : {}),
  }));

  // Percepts globaux : la première entité du kind, par ordre d'id. Il n'y a qu'un
  // compteur et qu'une couleur du jour ; l'ordre ne sert qu'à rester déterministe.
  const tempoEntity = mirror.getStates({ kind: TEMPO_KIND }).sort(byId)[0];
  const tempo: TempoSnapshot | undefined =
    tempoEntity && isKind(tempoEntity, TEMPO_KIND)
      ? {
          entityId: tempoEntity.id,
          couleurJour: tempoEntity.value.couleurJour,
          couleurDemain: tempoEntity.value.couleurDemain,
          periode: tempoEntity.value.periode,
          stale: isStale(tempoEntity),
        }
      : undefined;

  const powerEntity = mirror.getStates({ kind: 'power' }).sort(byId)[0];
  const power: PowerSnapshot | undefined =
    powerEntity && isKind(powerEntity, 'power')
      ? { entityId: powerEntity.id, va: powerEntity.value.va, stale: isStale(powerEntity) }
      : undefined;

  return {
    rooms,
    ...(tempo !== undefined ? { tempo } : {}),
    ...(power !== undefined ? { power } : {}),
    ...(sources.occupancy !== undefined ? { occupancy: sources.occupancy } : {}),
    shed: sources.shed,
    alerts: sources.alerts,
    lastPowerChangeAt: sources.lastPowerChangeAt,
  };
}
