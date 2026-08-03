import { readFileSync } from 'node:fs';

/**
 * L'état du simulateur EST le payload de l'API : on stocke les corps de réponse
 * tels que Netatmo les renvoie (`Record<string, unknown>`), pas un modèle réduit.
 * Recaler une fixture sur le compte réel recale donc le simulateur sans code.
 */
export type Json = Record<string, unknown>;

export interface SimState {
  /** `body` de `GET /api/homesdata`. */
  homesData: Json;
  /** `body.home` de `GET /api/homestatus`. */
  homeStatus: Json;
  /** `body` de `GET /api/getstationsdata`. */
  stationsData: Json;

  /** OAuth — le couple courant. Toute rotation le remplace intégralement. */
  accessToken: string;
  refreshToken: string;
  /** epoch ms ; `expireAccessToken()` le ramène dans le passé. */
  accessTokenExpiresAt: number;
  /** Nombre de rotations effectuées depuis le démarrage (assertions de test). */
  refreshCount: number;
  /** Refresh token révoqué côté Netatmo → « auth morte », réauth manuelle. */
  refreshTokenRevoked: boolean;
  /** Requêtes `/api/*` restant à faire échouer en 500 (`failNext`). */
  failuresRemaining: number;
}

const FIXTURES = new URL('../../../drivers/netatmo/__fixtures__/api/', import.meta.url);

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecords(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Fusion récursive du patch dans la cible (comme l'API : un patch partiel de
 * `dashboard_data` ne fait pas disparaître `min_temp`).
 */
export function mergeInto(target: Json, patch: Json): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isRecord(value) && isRecord(current)) mergeInto(current, value);
    else target[key] = value;
  }
}

function readFixture(file: string): Json {
  const url = new URL(file, FIXTURES);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    throw new Error(
      `fixture Netatmo illisible (${url.pathname}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(raw) || !isRecord(raw['body'])) {
    throw new Error(`fixture Netatmo sans objet 'body' : ${file}`);
  }
  return raw['body'];
}

/**
 * Réactualise les horodatages des mesures : les fixtures sont figées, mais une
 * station qui sert des mesures vieilles de six mois serait vue « périmée » par
 * le driver (ADR-009) dès la première seconde de test.
 */
export function refreshStationTimestamps(
  stationsData: Json,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  for (const device of asRecords(stationsData['devices'])) {
    device['last_status_store'] = nowSec;
    if (isRecord(device['dashboard_data'])) device['dashboard_data']['time_utc'] = nowSec;
    for (const module of asRecords(device['modules'])) {
      module['last_message'] = nowSec;
      module['last_seen'] = nowSec;
      if (isRecord(module['dashboard_data'])) module['dashboard_data']['time_utc'] = nowSec;
    }
  }
}

/**
 * État par défaut : les fixtures `apps/drivers/netatmo/__fixtures__/api/*.json`
 * (1 home « Maison » avec 1 thermostat, 1 station NAMain + module extérieur).
 * Relu à chaque appel — chaque simulateur possède donc son propre état mutable.
 */
export function loadFixtureState(): Pick<SimState, 'homesData' | 'homeStatus' | 'stationsData'> {
  const homeStatusBody = readFixture('homestatus.json');
  const home = homeStatusBody['home'];
  if (!isRecord(home)) throw new Error("fixture homestatus.json sans objet 'home'");
  const stationsData = readFixture('getstationsdata.json');
  refreshStationTimestamps(stationsData);
  return { homesData: readFixture('homesdata.json'), homeStatus: home, stationsData };
}

/** Le home unique du simulateur (`body.homes[0]` de homesdata). */
export function firstHome(state: SimState): Json {
  const home = asRecords(state.homesData['homes'])[0];
  if (home === undefined) throw new Error('sim-netatmo: aucun home dans homesdata');
  return home;
}

/** Une room de `homestatus` — la première si aucun id n'est donné. */
export function findStatusRoom(state: SimState, roomId?: string): Json | undefined {
  const rooms = asRecords(state.homeStatus['rooms']);
  return roomId === undefined ? rooms[0] : rooms.find((room) => room['id'] === roomId);
}

/**
 * Un module de station par son `module_name` (ou son `_id`) — le module
 * principal (NAMain) inclus, puisqu'il porte lui aussi des mesures.
 */
export function findStationModule(state: SimState, name: string): Json | undefined {
  for (const device of asRecords(state.stationsData['devices'])) {
    if (device['module_name'] === name || device['_id'] === name) return device;
    for (const module of asRecords(device['modules'])) {
      if (module['module_name'] === name || module['_id'] === name) return module;
    }
  }
  return undefined;
}
