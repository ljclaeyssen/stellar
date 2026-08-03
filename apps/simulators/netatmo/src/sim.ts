import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  asRecords,
  findStationModule,
  findStatusRoom,
  firstHome,
  isRecord,
  loadFixtureState,
  mergeInto,
  type Json,
  type SimState,
} from './state.js';

/**
 * Simulateur du cloud Netatmo — ADR-010 niveau 2.
 *
 * En **HTTP** et non HTTPS : le driver prend l'URL de l'API en configuration
 * (`NETATMO_API_URL`), et un TLS autosigné n'apporterait ici qu'un risque de
 * flakiness. Ce qui compte, et qui est reproduit fidèlement, c'est la
 * **rotation stricte du refresh token** : chaque `POST /oauth2/token` réussi
 * invalide le refresh présenté et en délivre un nouveau. C'est le point fragile
 * identifié par la spec §9 — un refresh raté = réauthentification manuelle.
 */
export interface SimNetatmoOptions {
  /** 0 (défaut) = port libre choisi par l'OS — indispensable en test parallèle. */
  port?: number;
  clientId?: string;
  clientSecret?: string;
  /** Refresh token initial — celui que l'humain colle dans le fichier de tokens. */
  refreshToken?: string;
  /** Durée de vie de l'access token (défaut 10800 s, comme Netatmo). */
  expiresInSeconds?: number;
  /** Journal JSON — silencieux par défaut (usage en test). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface SimNetatmo {
  readonly url: string;
  readonly port: number;
  /** État mutable : inspectable et modifiable directement dans un test. */
  readonly state: SimState;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Nombre de rotations de refresh token effectuées. */
  readonly refreshCount: number;
  /** Change la température mesurée d'une room (défaut : la première). */
  setRoomTemp(measured: number, roomId?: string): void;
  /** Fusionne un `dashboard_data` partiel dans un module de station (par nom ou `_id`). */
  setStationData(moduleName: string, dashboard: Json): void;
  /** L'access token courant devient périmé → 403 sur `/api/*` jusqu'au refresh. */
  expireAccessToken(): void;
  /** Le refresh token n'est plus honoré → « auth morte », réauthentification manuelle. */
  revokeRefreshToken(): void;
  /** Les `n` prochaines requêtes `/api/*` répondent 500 (test du retry/stale). */
  failNext(n: number): void;
  close(): Promise<void>;
}

const DEFAULT_EXPIRES_IN = 10_800;
const DEFAULT_CLIENT_ID = 'sim-netatmo-client-id';
const DEFAULT_CLIENT_SECRET = 'sim-netatmo-client-secret';

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** Erreur de l'API métier — enveloppe `{ error: { code, message } }`. */
const apiError = (res: ServerResponse, status: number, code: number, message: string): void =>
  send(res, status, { error: { code, message } });

/** Erreur OAuth — enveloppe plate `{ error, error_description }` (RFC 6749). */
const oauthError = (res: ServerResponse, error: string, description?: string): void =>
  send(res, 400, {
    error,
    ...(description === undefined ? {} : { error_description: description }),
  });

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const newToken = (prefix: string): string => `${prefix}-${randomUUID().replace(/-/g, '')}`;

export async function startSimNetatmo(options: SimNetatmoOptions = {}): Promise<SimNetatmo> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = options.clientSecret ?? DEFAULT_CLIENT_SECRET;
  const expiresIn = options.expiresInSeconds ?? DEFAULT_EXPIRES_IN;
  const log = options.log ?? ((): void => undefined);

  const state: SimState = {
    ...loadFixtureState(),
    // Aucun access token n'est valide au démarrage : le client doit passer par
    // /oauth2/token, exactement comme avec le vrai Netatmo.
    accessToken: '',
    refreshToken: options.refreshToken ?? newToken('refresh'),
    accessTokenExpiresAt: 0,
    refreshCount: 0,
    refreshTokenRevoked: false,
    failuresRemaining: 0,
  };

  const sockets = new Set<Socket>();

  const rotate = (): Json => {
    state.accessToken = newToken('access');
    state.refreshToken = newToken('refresh');
    state.accessTokenExpiresAt = Date.now() + expiresIn * 1_000;
    state.refreshCount += 1;
    log({ msg: 'rotation du refresh token', refreshCount: state.refreshCount });
    return {
      access_token: state.accessToken,
      refresh_token: state.refreshToken,
      expires_in: expiresIn,
      expire_in: expiresIn,
      scope: ['read_thermostat', 'write_thermostat', 'read_station'],
      token_type: 'bearer',
    };
  };

  /** `true` si la requête porte un Bearer valide et non périmé. */
  const authorize = (req: IncomingMessage, res: ServerResponse): boolean => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (token === '' || token !== state.accessToken) {
      apiError(res, 401, 2, 'Invalid access token');
      return false;
    }
    if (Date.now() >= state.accessTokenExpiresAt) {
      apiError(res, 403, 3, 'Access token expired');
      return false;
    }
    return true;
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = await readForm(req);
    if (form.get('grant_type') !== 'refresh_token') {
      oauthError(res, 'unsupported_grant_type', 'seul refresh_token est simulé');
      return;
    }
    if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
      oauthError(res, 'invalid_client', 'client_id/client_secret inconnus');
      return;
    }
    const presented = form.get('refresh_token') ?? '';
    if (state.refreshTokenRevoked || presented !== state.refreshToken) {
      // Rotation stricte : un refresh déjà consommé (ou révoqué) est mort.
      log({ msg: 'refresh token refusé', revoked: state.refreshTokenRevoked });
      oauthError(res, 'invalid_grant');
      return;
    }
    send(res, 200, rotate());
  };

  const handleApi = async (
    path: string,
    method: string,
    params: URLSearchParams,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (!authorize(req, res)) return;

    if (state.failuresRemaining > 0) {
      state.failuresRemaining -= 1;
      log({ msg: 'échec simulé', path, remaining: state.failuresRemaining });
      apiError(res, 500, 500, 'Internal server error');
      return;
    }

    if (method === 'POST') {
      const form = await readForm(req);
      for (const [key, value] of form) params.set(key, value);
    }

    switch (path) {
      case '/api/homesdata':
        send(res, 200, { body: state.homesData, status: 'ok' });
        return;

      case '/api/homestatus': {
        const homeId = params.get('home_id');
        if (homeId === null) {
          apiError(res, 400, 21, 'Invalid argument: home_id');
          return;
        }
        if (homeId !== firstHome(state)['id']) {
          apiError(res, 400, 2, 'Home not found');
          return;
        }
        send(res, 200, { body: { home: state.homeStatus }, status: 'ok' });
        return;
      }

      case '/api/setroomthermpoint': {
        const room = findStatusRoom(state, params.get('room_id') ?? undefined);
        const mode = params.get('mode');
        if (room === undefined) {
          apiError(res, 400, 2, 'Room not found');
          return;
        }
        if (mode !== 'manual' && mode !== 'home' && mode !== 'max' && mode !== 'off') {
          apiError(res, 400, 21, 'Invalid argument: mode');
          return;
        }
        if (mode === 'manual') {
          const temp = Number(params.get('temp'));
          if (!Number.isFinite(temp)) {
            apiError(res, 400, 21, 'Invalid argument: temp');
            return;
          }
          room['therm_setpoint_mode'] = 'manual';
          room['therm_setpoint_temperature'] = temp;
        } else if (mode === 'home') {
          // « home » annule la consigne manuelle : retour au programme.
          room['therm_setpoint_mode'] = 'schedule';
        } else {
          room['therm_setpoint_mode'] = mode;
        }
        log({ msg: 'consigne appliquée', mode, temp: params.get('temp') });
        send(res, 200, { status: 'ok' });
        return;
      }

      case '/api/setthermmode': {
        const mode = params.get('mode');
        if (mode !== 'schedule' && mode !== 'away' && mode !== 'hg') {
          apiError(res, 400, 21, 'Invalid argument: mode');
          return;
        }
        firstHome(state)['therm_mode'] = mode;
        for (const room of asRecords(state.homeStatus['rooms'])) room['therm_setpoint_mode'] = mode;
        log({ msg: 'mode thermique appliqué', mode });
        send(res, 200, { status: 'ok' });
        return;
      }

      case '/api/getstationsdata':
        send(res, 200, { body: state.stationsData, status: 'ok' });
        return;

      default:
        apiError(res, 404, 404, `Unknown endpoint ${path}`);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://sim.local');

    if (url.pathname === '/oauth2/token') {
      if (method !== 'POST') {
        apiError(res, 405, 405, 'method not allowed');
        return;
      }
      await handleToken(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(url.pathname, method, url.searchParams, req, res);
      return;
    }

    apiError(res, 404, 404, `Unknown endpoint ${url.pathname}`);
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log({ msg: 'erreur interne', error: String(err) });
      if (!res.headersSent) apiError(res, 500, 500, 'Internal server error');
      else res.end();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sim-netatmo: port inconnu');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    state,
    clientId,
    clientSecret,
    get refreshCount() {
      return state.refreshCount;
    },
    setRoomTemp(measured, roomId) {
      const room = findStatusRoom(state, roomId);
      if (room === undefined)
        throw new Error(`sim-netatmo: room inconnue ${roomId ?? '(première)'}`);
      room['therm_measured_temperature'] = measured;
    },
    setStationData(moduleName, dashboard) {
      const module = findStationModule(state, moduleName);
      if (module === undefined) throw new Error(`sim-netatmo: module inconnu ${moduleName}`);
      const current = module['dashboard_data'];
      if (isRecord(current)) mergeInto(current, dashboard);
      else module['dashboard_data'] = { ...dashboard };
    },
    expireAccessToken() {
      state.accessTokenExpiresAt = 0;
      log({ msg: 'access token périmé' });
    },
    revokeRefreshToken() {
      state.refreshTokenRevoked = true;
      log({ msg: 'refresh token révoqué — réauthentification manuelle requise' });
    },
    failNext(n) {
      state.failuresRemaining = n;
    },
    async close() {
      // Sans destruction explicite, les sockets keep-alive empêchent
      // `server.close()` de rendre la main — et le port de se libérer.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
