import { fetch as undiciFetch } from 'undici';
import type { z } from 'zod';
import type { Logger } from '@stellar/bus';
import type { TokenProvider } from './auth.js';
import {
  HomeStatusEnvelope,
  HomeStatusModule,
  HomeStatusRoom,
  HomesDataHome,
  NetatmoEnvelope,
  NetatmoWriteResponse,
  StationDevice,
  StationModule,
  type HomeStatus,
  type NetatmoStation,
} from './netatmo.js';

export interface SetRoomThermPoint {
  homeId: string;
  roomId: string;
  /** `manual` = consigne forcée (température requise) ; `home` = retour au programme. */
  mode: 'manual' | 'home';
  temp?: number;
}

export interface SetThermMode {
  homeId: string;
  mode: 'schedule' | 'away' | 'hg';
}

/**
 * Couture du driver avec le cloud Netatmo (ADR-010 niveau 1) : tout ce que le
 * driver sait faire du matériel passe par cette interface. Les tests la doublent —
 * ici par le simulateur HTTP réel (`@stellar/sim-netatmo`), niveau 2.
 */
export interface NetatmoApiLike {
  getHomesData(): Promise<HomesDataHome[]>;
  getHomeStatus(homeId: string): Promise<HomeStatus>;
  setRoomThermPoint(params: SetRoomThermPoint): Promise<void>;
  setThermMode(params: SetThermMode): Promise<void>;
  getStationsData(): Promise<NetatmoStation[]>;
}

export interface NetatmoApiOptions {
  /** `https://api.netatmo.com` (cloud) ou `http://127.0.0.1:8843` (simulateur). */
  baseUrl: string;
  tokens: TokenProvider;
  logger: Logger;
  requestTimeoutMs?: number;
}

/**
 * Valide une liste ressource par ressource : une room bizarre ne doit pas faire
 * disparaître toute la maison (règle n°4 : « message invalide → loggé et jeté »).
 */
function parseEach<T>(
  items: readonly unknown[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  label: string,
  logger: Logger,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (!parsed.success) {
      logger.warn('ressource Netatmo inattendue, ignorée', {
        resource: label,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

export function createNetatmoApi(options: NetatmoApiOptions): NetatmoApiLike {
  const { tokens, logger } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  /**
   * Une requête authentifiée. Sur 401/403 on tente **un** rafraîchissement puis
   * on rejoue : c'est le cas nominal quand l'access token expire en cours de
   * route (3 h chez Netatmo). Un second 401/403 est une vraie erreur — soit
   * l'auth est morte (le TokenStore l'aura déjà signalé), soit un scope manque.
   */
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    params: URLSearchParams,
    allowRetry = true,
  ): Promise<unknown> => {
    const token = await tokens.getAccessToken();
    const query = method === 'GET' && [...params].length > 0 ? `?${params.toString()}` : '';
    const res = await undiciFetch(`${baseUrl}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? params.toString() : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();

    if ((res.status === 401 || res.status === 403) && allowRetry) {
      logger.debug('access token refusé, rafraîchissement puis rejeu', {
        path,
        status: res.status,
      });
      await tokens.forceRefresh();
      return call(method, path, params, false);
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${method} ${path} → réponse non JSON`);
    }
  };

  /** Enveloppe illisible ⇒ erreur : le cycle de polling entier est faux, pas juste une ressource. */
  const body = async (method: 'GET' | 'POST', path: string, params = new URLSearchParams()) => {
    const envelope = NetatmoEnvelope.safeParse(await call(method, path, params));
    if (!envelope.success) throw new Error(`réponse ${path} hors contrat Netatmo`);
    return envelope.data.body;
  };

  const write = async (path: string, params: URLSearchParams): Promise<void> => {
    const json = await call('POST', path, params);
    const parsed = NetatmoWriteResponse.safeParse(json);
    if (!parsed.success || parsed.data.status !== 'ok') {
      throw new Error(`${path} → statut inattendu: ${JSON.stringify(json).slice(0, 200)}`);
    }
  };

  return {
    async getHomesData() {
      const raw = await body('GET', '/api/homesdata');
      const homes = (raw as { homes?: unknown })?.homes;
      if (!Array.isArray(homes)) throw new Error('réponse /api/homesdata sans tableau `homes`');
      return parseEach(homes, HomesDataHome, 'home', logger);
    },

    async getHomeStatus(homeId) {
      const raw = await body('GET', '/api/homestatus', new URLSearchParams({ home_id: homeId }));
      const home = HomeStatusEnvelope.safeParse((raw as { home?: unknown })?.home);
      if (!home.success) throw new Error('réponse /api/homestatus sans objet `home` exploitable');
      return {
        id: home.data.id,
        rooms: parseEach(home.data.rooms, HomeStatusRoom, 'room', logger),
        modules: parseEach(home.data.modules, HomeStatusModule, 'module', logger),
      };
    },

    async setRoomThermPoint(params) {
      const form = new URLSearchParams({
        home_id: params.homeId,
        room_id: params.roomId,
        mode: params.mode,
      });
      if (params.temp !== undefined) form.set('temp', String(params.temp));
      await write('/api/setroomthermpoint', form);
    },

    async setThermMode(params) {
      await write(
        '/api/setthermmode',
        new URLSearchParams({ home_id: params.homeId, mode: params.mode }),
      );
    },

    async getStationsData() {
      const raw = await body('GET', '/api/getstationsdata');
      const devices = (raw as { devices?: unknown })?.devices;
      if (!Array.isArray(devices)) {
        throw new Error('réponse /api/getstationsdata sans tableau `devices`');
      }
      return parseEach(devices, StationDevice, 'device', logger).map((device): NetatmoStation => {
        // Le NAMain porte des mesures comme ses modules : on le met à plat en
        // tête de liste, le mapping n'a plus qu'un seul cas à traiter.
        const main: StationModule = {
          _id: device._id,
          type: device.type,
          ...(device.module_name === undefined ? {} : { module_name: device.module_name }),
          ...(device.reachable === undefined ? {} : { reachable: device.reachable }),
          ...(device.dashboard_data === undefined ? {} : { dashboard_data: device.dashboard_data }),
        };
        return {
          id: device._id,
          stationName: device.station_name ?? device.module_name ?? device._id,
          modules: [main, ...parseEach(device.modules, StationModule, 'station module', logger)],
          raw: device,
        };
      });
    },
  };
}
