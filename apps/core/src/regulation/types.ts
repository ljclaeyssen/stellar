import type { ClimateMode, TempoValue } from '@stellar/contracts';
import type { LocalTime } from './time.js';

/**
 * Types de la régulation : ce que `decide` reçoit (un **instantané** extrait du
 * miroir) et ce qu'il rend (des **décisions** avec leur cause).
 *
 * Rien ici ne connaît le bus ni le miroir : `decide` est une fonction pure, c'est
 * ce qui permet aux golden tests de dérouler une journée entière en mémoire.
 */

export type OccupancyMode = 'present' | 'absent' | 'nuit' | 'hors_gel';
export type ActuatorRole = 'pac' | 'central';

export interface SensorReading {
  entityId: string;
  value: number;
  /** `stale` du contrat (ADR-009) ou driver hors ligne : donnée non exploitable. */
  stale: boolean;
}

export interface PresenceReading {
  entityId: string;
  value: boolean;
  /** `ts` de l'état, en ms — sert à la temporisation `presence_timeout_min`. */
  ts: number;
  stale: boolean;
}

export interface ActuatorState {
  entityId: string;
  role: ActuatorRole;
  /** L'entité existe dans le miroir. `false` = déclarée en config mais jamais vue. */
  known: boolean;
  stale: boolean;
  /** `home/health/<driver>` — un driver absent du registre est considéré en ligne. */
  driverOnline: boolean;
  power: boolean;
  mode: ClimateMode;
  targetTemp: number;
  /** Température intérieure remontée par la clim — fallback capteur de la pièce. */
  indoorTemp?: number;
}

export interface RoomSnapshot {
  room: string;
  /** Dans l'ordre de préférence de la config. */
  sensors: SensorReading[];
  presence: PresenceReading[];
  pac?: ActuatorState;
  central?: ActuatorState;
}

export interface TempoSnapshot {
  entityId: string;
  couleurJour: TempoValue['couleurJour'];
  couleurDemain: TempoValue['couleurDemain'];
  periode: TempoValue['periode'];
  stale: boolean;
}

export interface PowerSnapshot {
  entityId: string;
  va: number;
  stale: boolean;
}

/**
 * Instantané complet. Les trois derniers champs sont la **mémoire** de la
 * régulation : ils entrent et ressortent de `decide`, qui reste sans état.
 */
export interface Snapshot {
  rooms: RoomSnapshot[];
  tempo?: TempoSnapshot;
  power?: PowerSnapshot;
  /** Actionneurs actuellement délestés. */
  shed: readonly string[];
  /** Clés d'alertes déjà signalées — évite de crier à chaque tick. */
  alerts: readonly string[];
  /** entityId → date (ms) de la dernière bascule marche/arrêt commandée. */
  lastPowerChangeAt: Readonly<Record<string, number>>;
}

export interface DecisionCommand {
  /** `entityId` — le driver destinataire est résolu par le runtime (ADR-008). */
  target: string;
  action: 'set';
  params: { power?: boolean; mode?: ClimateMode; targetTemp?: number };
}

/**
 * - `action` : décision effective, publiée sur `home/event/core/regulation`.
 * - `alert` : anomalie, publiée **une fois par panne** (`alertKey`).
 * - `blocked` : décision empêchée (anti-court-cycle, délestage). Tracée en debug
 *   et dans les goldens, jamais sur le bus — sinon la moindre bande morte
 *   inonderait le journal.
 */
export type DecisionSeverity = 'action' | 'alert' | 'blocked';

export interface Decision {
  /** Pièce concernée, ou `maison` pour les décisions globales (délestage). */
  room: string;
  /** Identifiant court et stable — c'est lui que comparent les goldens. */
  decision: string;
  /** Phrase lisible par un humain : l'exigence du DoD P6. */
  cause: string;
  severity: DecisionSeverity;
  command?: DecisionCommand;
  /** Présent si `severity === 'alert'` : clé de déduplication. */
  alertKey?: string;
}

export interface EnergyEvaluation {
  periode: 'HP' | 'HC';
  couleurJour?: TempoValue['couleurJour'];
  couleurDemain?: TempoValue['couleurDemain'];
  pacAllowed: boolean;
  /** Actionneur à privilégier quand la pièce en a deux. */
  preferred: ActuatorRole;
  /** °C ajoutés à la consigne (préchauffe avant jour rouge), 0 sinon. */
  preheatDelta: number;
  /** Fragment de cause réutilisé dans toutes les décisions du tick. */
  label: string;
  /** `percept` : état Tempo lu du miroir ; `fallback` : absent ou stale (bleu prudent). */
  source: 'percept' | 'fallback';
}

export interface RoomEvaluation {
  room: string;
  temperature?: number;
  /** `entityId` du capteur retenu, ou `<clim>.indoorTemp`. */
  temperatureSource?: string;
  /** Aucune mesure exploitable : consigne hors-gel. */
  degraded: boolean;
  mode: OccupancyMode;
  setpoint: number;
  preheat: boolean;
  /** Actionneur retenu pour chauffer, `undefined` si aucun n'est disponible. */
  chosen?: ActuatorRole;
  decisions: Decision[];
}

export interface Outcome {
  now: number;
  local: LocalTime;
  energy: EnergyEvaluation;
  rooms: RoomEvaluation[];
  /** Décisions globales (délestage), dans l'ordre d'émission. */
  global: Decision[];
  /** Toutes les décisions à plat : global puis pièces, dans l'ordre de la config. */
  decisions: Decision[];
  /** Nouvel ensemble délesté — à reporter dans le prochain snapshot. */
  shed: string[];
  /** Nouvel ensemble d'alertes actives — idem. */
  alerts: string[];
}

/** Une commande qui bascule l'alimentation : c'est elle que borne l'anti-court-cycle. */
export function isPowerToggle(command: DecisionCommand): boolean {
  return command.params.power !== undefined;
}
