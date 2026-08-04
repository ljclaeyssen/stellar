import { fetch as undiciFetch } from 'undici';
import type { Logger } from '@stellar/bus';
import {
  RteCalendarValue,
  RteCalendarsResponse,
  RteTokenResponse,
  couleurFromRte,
  type TempoCouleur,
  type TempoSourceLike,
} from './tempo.js';
import { addDays, parisEpochOf, parisIso, dayKeyOfPeriodStart } from './time.js';

export const TOKEN_PATH = '/token/oauth/';
export const CALENDARS_PATH = '/open_api/tempo_like_supply_contract/v1/tempo_like_calendars';

export interface RteSourceOptions {
  /** `https://digital.iservices.rte-france.com` en prod, le simulateur en test. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  logger: Logger;
  requestTimeoutMs?: number;
  /** Marge avant expiration déclarée : on redemande un token un peu avant. */
  expirySkewMs?: number;
}

/**
 * Source primaire : l'API « Tempo Like Supply Contract » du portail RTE.
 *
 * OAuth2 **client credentials** — pas de refresh token, donc rien à persister
 * (contrairement à Netatmo) : un token périmé se redemande, point. L'access
 * token ne vit qu'en mémoire et n'est jamais loggé (spec §14).
 */
export function createRteSource(options: RteSourceOptions): TempoSourceLike {
  const { clientId, clientSecret, logger } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const expirySkewMs = options.expirySkewMs ?? 60_000;
  /** Défaut prudent si l'API omet `expires_in`. */
  const DEFAULT_EXPIRES_IN_S = 7_200;

  let accessToken: string | null = null;
  let expiresAt = 0;

  const fetchToken = async (): Promise<string> => {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await undiciFetch(`${baseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // Le corps peut contenir un `error_description` utile ; jamais de secret
      // (le secret voyage dans l'en-tête, pas dans la réponse).
      throw new Error(`POST ${TOKEN_PATH} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`POST ${TOKEN_PATH} → réponse non JSON`);
    }
    const parsed = RteTokenResponse.safeParse(json);
    if (!parsed.success)
      throw new Error(`réponse ${TOKEN_PATH} hors contrat (access_token absent ?)`);

    accessToken = parsed.data.access_token;
    expiresAt =
      Date.now() + (parsed.data.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1_000 - expirySkewMs;
    logger.debug('token RTE obtenu', { expiresInSec: parsed.data.expires_in });
    return accessToken;
  };

  const token = async (): Promise<string> => {
    if (accessToken !== null && Date.now() < expiresAt) return accessToken;
    return fetchToken();
  };

  /**
   * Un 401/403 en cours de route (token révoqué côté RTE, redéploiement du
   * portail) : on redemande **un** token et on rejoue une fois. Un second refus
   * est une vraie erreur — le driver basculera sur le fallback.
   */
  const call = async (
    path: string,
    query: URLSearchParams,
    allowRetry = true,
  ): Promise<unknown> => {
    const bearer = await token();
    const res = await undiciFetch(`${baseUrl}${path}?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    if ((res.status === 401 || res.status === 403) && allowRetry) {
      logger.debug('token RTE refusé, renouvellement puis rejeu', { status: res.status });
      accessToken = null;
      return call(path, query, false);
    }
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`GET ${path} → réponse non JSON`);
    }
  };

  return {
    name: 'rte',

    async fetchColors(dayKeys) {
      const first = dayKeys[0];
      const last = dayKeys[dayKeys.length - 1];
      if (first === undefined || last === undefined) return {};

      // La fenêtre demandée est celle des jours Tempo : de 6 h du premier à 6 h
      // du lendemain du dernier, en heure de Paris avec l'offset explicite.
      const query = new URLSearchParams({
        start_date: parisIso(parisEpochOf(first, 6)),
        end_date: parisIso(parisEpochOf(addDays(last, 1), 6)),
      });
      const envelope = RteCalendarsResponse.safeParse(await call(CALENDARS_PATH, query));
      if (!envelope.success) throw new Error(`réponse ${CALENDARS_PATH} hors contrat RTE`);

      const colors: Record<string, TempoCouleur> = {};
      for (const raw of envelope.data.tempo_like_calendars.values) {
        const value = RteCalendarValue.safeParse(raw);
        if (!value.success) {
          logger.warn('période RTE inattendue, ignorée', {
            issues: value.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          });
          continue;
        }
        const couleur = couleurFromRte(value.data.value);
        if (couleur === undefined) {
          logger.warn('couleur RTE inconnue, ignorée', { value: value.data.value });
          continue;
        }
        colors[dayKeyOfPeriodStart(value.data.start_date)] = couleur;
      }
      return colors;
    },
  };
}
