import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  CODE_BY_COULEUR,
  RTE_BY_COULEUR,
  loadTemplates,
  type SimCouleur,
  type SimTempoState,
} from './state.js';
import { addDays, parisEpochOf, parisIso, tempoDayKey } from './time.js';

/**
 * Simulateur des **deux** sources Tempo — ADR-010 niveau 2.
 *
 * Un seul process, deux APIs sur le même port :
 *
 * - **RTE** (source primaire, avec compte) : `POST /token/oauth/` (OAuth2 client
 *   credentials, Basic base64(id:secret)) puis
 *   `GET /open_api/tempo_like_supply_contract/v1/tempo_like_calendars`.
 * - **api-couleur-tempo.fr** (fallback public, sans compte) :
 *   `GET /api/jourTempo/<yyyy-mm-dd>`.
 *
 * Les tester ensemble sur un même serveur est délibéré : c'est la **bascule**
 * de l'une à l'autre qui est le comportement intéressant du driver, et elle se
 * pilote ici d'un `failRte(true)`.
 *
 * En HTTP et non HTTPS, comme sim-netatmo : les deux URLs sont des paramètres du
 * driver (`RTE_API_URL`, `TEMPO_FALLBACK_URL`), et un TLS autosigné n'ajouterait
 * que de la flakiness.
 */
export interface SimTempoOptions {
  /** 0 (défaut) = port libre choisi par l'OS — indispensable en test parallèle. */
  port?: number;
  clientId?: string;
  clientSecret?: string;
  /**
   * Horloge du simulateur : elle définit « aujourd'hui » et « demain » au sens
   * Tempo (bascule à 6 h, heure de Paris). En test, passer **la même** horloge
   * gelée qu'au driver — sinon `setColors({ today })` ne parlerait pas du même
   * jour que le driver.
   */
  clock?: () => number;
  /** Couleur initiale du jour courant (défaut : bleu, le cas des ~300 j/an). */
  today?: SimCouleur;
  /** Couleur initiale du lendemain — omise = inconnue, le cas d'avant 11 h. */
  tomorrow?: SimCouleur;
  /** Journal JSON — silencieux par défaut (usage en test). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface SimTempo {
  readonly url: string;
  readonly port: number;
  /** État mutable : inspectable et modifiable directement dans un test. */
  readonly state: SimTempoState;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Nombre d'appels `POST /token/oauth/` reçus. */
  readonly tokenCalls: number;
  /** Nombre d'appels `GET …/tempo_like_calendars` reçus. */
  readonly rteCalendarCalls: number;
  /** Nombre d'appels `GET /api/jourTempo/…` reçus. */
  readonly fallbackCalls: number;
  /** Couleurs du jour Tempo courant et/ou du suivant (`null` = inconnue). */
  setColors(colors: { today?: SimCouleur; tomorrow?: SimCouleur | null }): void;
  /** Couleur d'un jour Tempo précis (`null` = inconnue, comme avant 11 h). */
  setColorForDay(dayKey: string, couleur: SimCouleur | null): void;
  /** Le lendemain redevient inconnu : absent de RTE, `codeJour: 0` côté fallback. */
  setTomorrowUnknown(): void;
  /** L'API RTE (token + calendriers) répond 503. */
  failRte(down: boolean): void;
  /** L'API opendata répond 503. */
  failFallback(down: boolean): void;
  close(): Promise<void>;
}

const DEFAULT_CLIENT_ID = 'sim-tempo-client-id';
const DEFAULT_CLIENT_SECRET = 'sim-tempo-client-secret';
const DEFAULT_EXPIRES_IN = 7_200;
export const RTE_TOKEN_PATH = '/token/oauth/';
export const RTE_CALENDARS_PATH = '/open_api/tempo_like_supply_contract/v1/tempo_like_calendars';
export const FALLBACK_PATH_PREFIX = '/api/jourTempo/';

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** Forme d'erreur du portail RTE (`{ error, error_description }`). */
const rteError = (res: ServerResponse, status: number, error: string, description: string): void =>
  send(res, status, { error, error_description: description });

export async function startSimTempo(options: SimTempoOptions = {}): Promise<SimTempo> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = options.clientSecret ?? DEFAULT_CLIENT_SECRET;
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((): void => undefined);
  const templates = loadTemplates();

  const state: SimTempoState = {
    colors: {},
    rteDown: false,
    fallbackDown: false,
    accessToken: `sim-tempo-access-${randomUUID().replace(/-/g, '')}`,
    tokenCalls: 0,
    rteCalendarCalls: 0,
    fallbackCalls: 0,
  };

  const todayKey = (): string => tempoDayKey(clock());
  const setColor = (dayKey: string, couleur: SimCouleur | null): void => {
    if (couleur === null) delete state.colors[dayKey];
    else state.colors[dayKey] = couleur;
  };
  setColor(todayKey(), options.today ?? 'bleu');
  if (options.tomorrow !== undefined) setColor(addDays(todayKey(), 1), options.tomorrow);

  const sockets = new Set<Socket>();

  /** Le Bearer présenté est-il celui délivré par `/token/oauth/` ? */
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${state.accessToken}`;
  };

  const handleToken = (req: IncomingMessage, res: ServerResponse): void => {
    state.tokenCalls += 1;
    if (state.rteDown) {
      rteError(res, 503, 'service_unavailable', 'panne simulée du portail RTE');
      return;
    }
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) {
      rteError(
        res,
        401,
        'invalid_client',
        'en-tête Basic attendu (base64 client_id:client_secret)',
      );
      return;
    }
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    if (decoded !== `${clientId}:${clientSecret}`) {
      rteError(res, 401, 'invalid_client', 'client_id/client_secret inconnus');
      return;
    }
    // Rotation à chaque demande : un token mémorisé trop longtemps par le driver
    // se ferait donc refuser — c'est le chemin 401 → re-token qu'on veut exercer.
    state.accessToken = `sim-tempo-access-${randomUUID().replace(/-/g, '')}`;
    log({ msg: 'token RTE délivré', tokenCalls: state.tokenCalls });
    send(res, 200, {
      ...templates.token,
      access_token: state.accessToken,
      expires_in: DEFAULT_EXPIRES_IN,
    });
  };

  /**
   * Les jours Tempo couverts par `[start_date, end_date[`. Le simulateur ne
   * renvoie que les jours **publiés** (couleur connue) : c'est ainsi que RTE se
   * comporte avant 11 h — le lendemain n'existe simplement pas dans la réponse.
   */
  const daysInRange = (startMs: number, endMs: number): string[] => {
    const days: string[] = [];
    let key = tempoDayKey(startMs);
    // Garde-fou : 400 itérations ≈ 13 mois, largement au-delà de tout usage.
    for (let guard = 0; guard < 400; guard += 1) {
      const dayStart = parisEpochOf(key, 6);
      if (dayStart >= endMs) break;
      days.push(key);
      key = addDays(key, 1);
    }
    return days;
  };

  const handleCalendars = (req: IncomingMessage, url: URL, res: ServerResponse): void => {
    state.rteCalendarCalls += 1;
    if (state.rteDown) {
      rteError(res, 503, 'service_unavailable', 'panne simulée du portail RTE');
      return;
    }
    if (!authorized(req)) {
      rteError(res, 401, 'invalid_token', 'access token absent ou périmé');
      return;
    }
    const startRaw = url.searchParams.get('start_date');
    const endRaw = url.searchParams.get('end_date');
    const startMs = startRaw === null ? Number.NaN : Date.parse(startRaw);
    const endMs = endRaw === null ? Number.NaN : Date.parse(endRaw);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      rteError(res, 400, 'invalid_request', 'start_date et end_date ISO 8601 attendus');
      return;
    }

    const values = daysInRange(startMs, endMs).flatMap((day) => {
      const couleur = state.colors[day];
      // Jour non publié : absent de la réponse, exactement comme chez RTE.
      if (couleur === undefined) return [];
      return [
        {
          ...templates.rteValue,
          start_date: parisIso(parisEpochOf(day, 6)),
          end_date: parisIso(parisEpochOf(addDays(day, 1), 6)),
          value: RTE_BY_COULEUR[couleur],
          // Publication de la veille vers 11 h (spec §2).
          updated_date: parisIso(parisEpochOf(addDays(day, -1), 11)),
        },
      ];
    });

    log({ msg: 'calendrier RTE servi', days: values.length });
    send(res, 200, {
      tempo_like_calendars: {
        ...templates.rteEnvelope,
        start_date: parisIso(startMs),
        end_date: parisIso(endMs),
        values,
      },
    });
  };

  const handleFallback = (dateKey: string, res: ServerResponse): void => {
    state.fallbackCalls += 1;
    if (state.fallbackDown) {
      send(res, 503, { message: 'panne simulée de api-couleur-tempo' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      send(res, 400, { message: `date invalide: ${dateKey}` });
      return;
    }
    const couleur = state.colors[dateKey];
    log({ msg: 'jour opendata servi', dateKey, couleur: couleur ?? 'inconnue' });
    send(res, 200, {
      ...templates.jourTempo,
      dateJour: dateKey,
      // 0 = inconnu : c'est ainsi que l'opendata annonce un lendemain non publié.
      codeJour: couleur === undefined ? 0 : CODE_BY_COULEUR[couleur],
      periodeUpdate: parisIso(parisEpochOf(addDays(dateKey, -1), 11)),
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://sim.local');

    if (url.pathname === RTE_TOKEN_PATH) {
      if (method !== 'POST') {
        rteError(res, 405, 'method_not_allowed', 'POST attendu');
        return;
      }
      handleToken(req, res);
      return;
    }
    if (url.pathname === RTE_CALENDARS_PATH) {
      handleCalendars(req, url, res);
      return;
    }
    if (url.pathname.startsWith(FALLBACK_PATH_PREFIX)) {
      handleFallback(decodeURIComponent(url.pathname.slice(FALLBACK_PATH_PREFIX.length)), res);
      return;
    }
    send(res, 404, { message: `Unknown endpoint ${url.pathname}` });
  };

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      log({ msg: 'erreur interne', error: String(err) });
      if (!res.headersSent) send(res, 500, { message: 'Internal server error' });
      else res.end();
    }
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
  if (address === null || typeof address === 'string') throw new Error('sim-tempo: port inconnu');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    state,
    clientId,
    clientSecret,
    get tokenCalls() {
      return state.tokenCalls;
    },
    get rteCalendarCalls() {
      return state.rteCalendarCalls;
    },
    get fallbackCalls() {
      return state.fallbackCalls;
    },
    setColors(colors) {
      if (colors.today !== undefined) setColor(todayKey(), colors.today);
      if (colors.tomorrow !== undefined) setColor(addDays(todayKey(), 1), colors.tomorrow);
    },
    setColorForDay(dayKey, couleur) {
      setColor(dayKey, couleur);
    },
    setTomorrowUnknown() {
      setColor(addDays(todayKey(), 1), null);
    },
    failRte(down) {
      state.rteDown = down;
      log({ msg: 'panne RTE simulée', down });
    },
    failFallback(down) {
      state.fallbackDown = down;
      log({ msg: 'panne opendata simulée', down });
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
