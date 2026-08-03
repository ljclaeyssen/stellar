import type { Logger } from '@stellar/bus';
import {
  HumidityValue,
  TemperatureValue,
  type ClimateMode,
  type ClimateValue,
  type Kind,
} from '@stellar/contracts';
import type {
  Dashboard,
  HomeStatus,
  HomeStatusRoom,
  HomesDataHome,
  NetatmoStation,
  StationModule,
} from './netatmo.js';

/** Ce qu'un cycle de polling produit : de quoi fabriquer une `Entity` du bus. */
export interface Percept {
  entityId: string;
  kind: Kind;
  room?: string;
  unit?: string;
  value: unknown;
  /** Mesure périmée ou module injoignable — ADR-009 (le process, lui, va bien). */
  stale?: boolean;
}

export interface ThermostatRoom {
  /** id Netatmo de la room — cible des `setroomthermpoint`. */
  roomId: string;
  /** Nom tel qu'affiché dans l'app Netatmo. */
  name: string;
  entityId: string;
  room: string;
}

export interface ThermostatTopology {
  homeId: string;
  homeName: string;
  rooms: ThermostatRoom[];
}

/** Seul module « thermostat » du parc (ADR-001 : la chaudière passe par lui). */
const THERMOSTAT_MODULE_TYPE = 'NATherm1';
/** Module extérieur de la station météo. */
const OUTDOOR_MODULE_TYPE = 'NAModule1';
/** Station météo elle-même (intérieur : T°, humidité, CO2, bruit, pression). */
const MAIN_MODULE_TYPE = 'NAMain';

/**
 * snake_case sans accents : `Chambre bébé` → `chambre_bebe`.
 * Décomposition NFD puis suppression des diacritiques, tout le reste devient `_`.
 */
export function slug(input: string): string {
  const out = input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out === '' ? 'sans_nom' : out;
}

/** Suffixe `_2`, `_3`… en cas de collision d'entityId (deux pièces homonymes). */
function uniqueId(base: string, taken: Set<string>, logger: Logger): string {
  let entityId = base;
  let suffix = 1;
  while (taken.has(entityId)) {
    suffix += 1;
    entityId = `${base}_${suffix}`;
  }
  if (entityId !== base) logger.warn('collision d’entityId, suffixe ajouté', { base, entityId });
  taken.add(entityId);
  return entityId;
}

/**
 * `therm_setpoint_mode` (Netatmo) → `ClimateValue` (contrat).
 *
 * | Netatmo            | power | mode   | pourquoi                                        |
 * | ------------------ | ----- | ------ | ----------------------------------------------- |
 * | `manual`, `max`    | true  | heat   | consigne forcée par un humain ou par nous       |
 * | `schedule`, `home` | true  | auto   | le programme du thermostat décide               |
 * | `away`, `hg`, `off`| false | heat   | pas de chauffe demandée (absence / hors-gel)    |
 *
 * `mode` n'a que 5 valeurs au contrat (`heat|cool|fan|dry|auto`) : une chaudière
 * gaz ne fait que chauffer, d'où `heat` même à l'arrêt — c'est `power` qui porte
 * l'information « ça chauffe ou non ». `fan: 'none'` pour la même raison : le
 * contrat impose le champ, un thermostat n'a pas de ventilation pilotable.
 */
export const MODE_BY_SETPOINT: Record<string, { power: boolean; mode: ClimateMode }> = {
  manual: { power: true, mode: 'heat' },
  max: { power: true, mode: 'heat' },
  schedule: { power: true, mode: 'auto' },
  home: { power: true, mode: 'auto' },
  program: { power: true, mode: 'auto' },
  away: { power: false, mode: 'heat' },
  hg: { power: false, mode: 'heat' },
  off: { power: false, mode: 'heat' },
};

/**
 * Inventaire `homesdata` → pièces équipées d'un thermostat.
 *
 * Un seul home est retenu (le parc en compte un — spec §3) : en supporter
 * plusieurs coûterait un `homestatus` par home à chaque cycle pour un besoin qui
 * n'existe pas. Les autres sont signalés, pas silencieusement perdus.
 */
export function buildThermostatTopology(
  homes: readonly HomesDataHome[],
  logger: Logger,
): ThermostatTopology | null {
  const candidates: ThermostatTopology[] = [];

  for (const home of homes) {
    const thermostatIds = new Set(
      home.modules.filter((module) => module.type === THERMOSTAT_MODULE_TYPE).map((m) => m.id),
    );
    if (thermostatIds.size === 0) continue;
    const roomsWithThermostat = new Set(
      home.modules
        .filter((module) => thermostatIds.has(module.id) && module.room_id !== undefined)
        .map((module) => module.room_id),
    );

    const taken = new Set<string>();
    const rooms: ThermostatRoom[] = [];
    for (const room of home.rooms) {
      const equipped =
        roomsWithThermostat.has(room.id) ||
        room.module_ids.some((moduleId) => thermostatIds.has(moduleId));
      if (!equipped) continue;
      const roomSlug = slug(room.name);
      rooms.push({
        roomId: room.id,
        name: room.name,
        entityId: uniqueId(`thermostat_${roomSlug}`, taken, logger),
        room: roomSlug,
      });
    }
    if (rooms.length > 0) candidates.push({ homeId: home.id, homeName: home.name, rooms });
  }

  const [first, ...others] = candidates;
  if (first === undefined) return null;
  if (others.length > 0) {
    logger.warn('plusieurs maisons Netatmo équipées, seule la première est pilotée', {
      retenue: first.homeName,
      ignorees: others.map((home) => home.homeName),
    });
  }
  return first;
}

/**
 * État d'une room → `ClimateValue`. `null` si la room n'a pas de consigne
 * exploitable (thermostat jamais joint depuis le démarrage du cloud) : mieux vaut
 * ne rien publier qu'inventer une consigne.
 */
export function toClimateValue(room: HomeStatusRoom, logger: Logger): ClimateValue | null {
  if (room.therm_setpoint_temperature === undefined) {
    logger.warn('room sans consigne, percept climate ignoré', { roomId: room.id });
    return null;
  }
  const setpointMode = room.therm_setpoint_mode ?? 'schedule';
  const mapped = MODE_BY_SETPOINT[setpointMode];
  if (mapped === undefined) {
    logger.warn('mode de consigne Netatmo inconnu, traité comme « pas de chauffe »', {
      roomId: room.id,
      setpointMode,
    });
  }
  const { power, mode } = mapped ?? { power: false, mode: 'heat' as const };
  return {
    power,
    mode,
    targetTemp: room.therm_setpoint_temperature,
    ...(room.therm_measured_temperature === undefined
      ? {}
      : { indoorTemp: room.therm_measured_temperature }),
    // Le contrat exige `fan` : une chaudière n'en a pas.
    fan: 'none',
  };
}

export function buildThermostatPercepts(
  status: HomeStatus,
  topology: ThermostatTopology,
  logger: Logger,
): Percept[] {
  const byRoomId = new Map(status.rooms.map((room) => [room.id, room]));
  const percepts: Percept[] = [];

  for (const declared of topology.rooms) {
    const room = byRoomId.get(declared.roomId);
    if (room === undefined) {
      logger.warn('room absente de homestatus, percept ignoré', { roomId: declared.roomId });
      continue;
    }
    const value = toClimateValue(room, logger);
    if (value === null) continue;
    percepts.push({
      entityId: declared.entityId,
      kind: 'climate',
      room: declared.room,
      value,
      // Thermostat injoignable (pile morte, relais débranché) : ADR-009.
      ...(room.reachable === false ? { stale: true } : {}),
    });
  }
  return percepts;
}

export interface StationPerceptOptions {
  logger: Logger;
  /** Horloge injectée — les tests n'ont pas à attendre. */
  now?: number;
  /** Au-delà, une mesure est publiée `stale` (défaut 1 h ; la station émet toutes les 5 min). */
  freshnessMs?: number;
}

const DEFAULT_FRESHNESS_MS = 3_600_000;

/** `dashboard_data.time_utc` est en **secondes** epoch. */
function measuredAtMs(dashboard: Dashboard): number | undefined {
  return dashboard.time_utc === undefined ? undefined : dashboard.time_utc * 1_000;
}

/**
 * Station météo → percepts `temperature` / `humidity` par module + un agrégat
 * `weather` par station (pression, CO2, bruit, T° extérieure…).
 *
 * Un module **sans `dashboard_data`** ne produit rien du tout : il n'a jamais
 * mesuré (pile absente à la première lecture), et publier une valeur inventée
 * serait pire que l'absence. Un module dont la **dernière mesure est vieille**,
 * lui, produit ses percepts marqués `stale: true` : effacer la dernière valeur
 * connue du bus priverait le core d'un fallback utile, alors que l'ADR-009 lui
 * donne exactement le drapeau qu'il faut pour s'en méfier.
 */
export function buildStationPercepts(
  stations: readonly NetatmoStation[],
  options: StationPerceptOptions,
): Percept[] {
  const { logger } = options;
  const now = options.now ?? Date.now();
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const taken = new Set<string>();
  const percepts: Percept[] = [];

  const isStale = (module: StationModule, dashboard: Dashboard): boolean => {
    if (module.reachable === false) return true;
    const measured = measuredAtMs(dashboard);
    return measured === undefined || now - measured > freshnessMs;
  };

  for (const station of stations) {
    const weather: Record<string, unknown> = {};
    let weatherStale = false;

    for (const module of station.modules) {
      const dashboard = module.dashboard_data;
      const name = module.module_name ?? station.stationName;
      if (dashboard === undefined) {
        logger.debug('module de station sans mesure, ignoré', { module: name, type: module.type });
        continue;
      }
      const stale = isStale(module, dashboard);
      const nameSlug = slug(name);
      const isMain = module.type === MAIN_MODULE_TYPE;
      const isOutdoor = module.type === OUTDOOR_MODULE_TYPE;

      if (dashboard.Temperature !== undefined) {
        if (TemperatureValue.safeParse(dashboard.Temperature).success) {
          percepts.push({
            entityId: uniqueId(`temp_${nameSlug}`, taken, logger),
            kind: 'temperature',
            room: nameSlug,
            unit: '°C',
            value: dashboard.Temperature,
            ...(stale ? { stale: true } : {}),
          });
        } else {
          logger.warn('température hors bornes physiques, ignorée', {
            module: name,
            value: dashboard.Temperature,
          });
        }
      }

      if (dashboard.Humidity !== undefined) {
        if (HumidityValue.safeParse(dashboard.Humidity).success) {
          percepts.push({
            entityId: uniqueId(`humidity_${nameSlug}`, taken, logger),
            kind: 'humidity',
            room: nameSlug,
            unit: '%',
            value: dashboard.Humidity,
            ...(stale ? { stale: true } : {}),
          });
        } else {
          logger.warn('humidité hors bornes, ignorée', { module: name, value: dashboard.Humidity });
        }
      }

      if (isMain) {
        weatherStale = stale;
        if (dashboard.Pressure !== undefined) weather['pressure'] = dashboard.Pressure;
        if (dashboard.AbsolutePressure !== undefined) {
          weather['absolutePressure'] = dashboard.AbsolutePressure;
        }
        if (dashboard.CO2 !== undefined) weather['co2'] = dashboard.CO2;
        if (dashboard.Noise !== undefined) weather['noise'] = dashboard.Noise;
        if (dashboard.Temperature !== undefined) weather['tempIn'] = dashboard.Temperature;
        if (dashboard.Humidity !== undefined) weather['humidityIn'] = dashboard.Humidity;
        const measured = measuredAtMs(dashboard);
        if (measured !== undefined) weather['measuredAt'] = new Date(measured).toISOString();
      }
      if (isOutdoor) {
        if (dashboard.Temperature !== undefined) weather['tempOut'] = dashboard.Temperature;
        if (dashboard.Humidity !== undefined) weather['humidityOut'] = dashboard.Humidity;
      }
    }

    if (Object.keys(weather).length === 0) continue;
    const stationSlug = slug(station.stationName);
    percepts.push({
      entityId: uniqueId(`weather_${stationSlug}`, taken, logger),
      kind: 'weather',
      room: stationSlug,
      value: weather,
      ...(weatherStale ? { stale: true } : {}),
    });
  }

  return percepts;
}
