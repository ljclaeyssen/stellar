import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import type { Logger } from '@stellar/bus';
import { TokenFile } from './config.js';
import { OAuthError, TokenResponse } from './netatmo.js';

/**
 * L'authentification est morte : plus aucun refresh token valide, seul un humain
 * peut repartir (Token generator sur dev.netatmo.com → réécriture du fichier).
 * Le driver la distingue d'une panne réseau : elle marque les entités `stale` et
 * fait rejeter les commandes **immédiatement**, sans attendre deux cycles.
 */
export class AuthDeadError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthDeadError';
  }
}

export interface TokenProvider {
  /** Access token valide, rafraîchi à la demande. Lève `AuthDeadError` si l'auth est morte. */
  getAccessToken(): Promise<string>;
  /** Force un rafraîchissement (après un 401/403 en cours de route). */
  forceRefresh(): Promise<string>;
}

export interface TokenStore extends TokenProvider {
  /** Vrai quand seul un humain peut débloquer la situation. */
  readonly authDead: boolean;
  /** Nombre de rotations réussies depuis le démarrage (observabilité, tests). */
  readonly refreshCount: number;
  /** Lit le fichier de tokens — appelé au démarrage pour échouer tôt et clairement. */
  load(): Promise<void>;
}

export interface TokenStoreOptions {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  logger: Logger;
  /** Marge avant expiration déclarée : on rafraîchit un peu avant (défaut 120 s). */
  expirySkewMs?: number;
  requestTimeoutMs?: number;
  /** Intervalle du retry doux quand l'auth est morte (défaut 15 min). */
  authRetryMs?: number;
  onAuthDead?: (reason: string) => void;
  onAuthRecovered?: () => void;
}

/** Message unique : c'est lui que l'humain lira dans les logs et dans un ack rejeté. */
export const AUTH_DEAD_MESSAGE =
  'authentification Netatmo morte — réauthentification manuelle requise : régénérer un refresh token sur dev.netatmo.com (Token generator) et réécrire le fichier de tokens (voir TODO_LJ.md §P3)';

/** Codes OAuth2 qui ne se répareront jamais tout seuls (par opposition à une panne réseau). */
const FATAL_OAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_request',
  'unauthorized_client',
  'invalid_scope',
  'unsupported_grant_type',
]);

/**
 * Gardien du refresh token Netatmo.
 *
 * Point critique de la spec §9 : **Netatmo fait tourner le refresh token**. Chaque
 * `POST /oauth2/token` invalide celui présenté et en délivre un nouveau. D'où
 * trois invariants tenus ici :
 *
 * 1. **Persistance immédiate et atomique** (écriture d'un fichier temporaire puis
 *    `rename`) : entre la réponse HTTP et le `rename`, l'ancien token est déjà
 *    mort côté Netatmo. Un crash au mauvais moment ne doit pas laisser un fichier
 *    tronqué — d'où le rename, atomique sur les systèmes de fichiers usuels.
 * 2. **Un seul rafraîchissement en vol** : deux refresh concurrents présenteraient
 *    le même token, le second serait rejeté et l'on croirait l'auth morte.
 * 3. **L'access token ne vit qu'en mémoire** et n'est jamais loggé (le logger du
 *    bus redacte déjà `token`/`key`, mais aucun payload OAuth n'est loggé du tout).
 */
export function createTokenStore(options: TokenStoreOptions): TokenStore {
  const { clientId, clientSecret, tokenFile, logger } = options;
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const expirySkewMs = options.expirySkewMs ?? 120_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const authRetryMs = options.authRetryMs ?? 900_000;

  let refreshToken: string | null = null;
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;
  let refreshCount = 0;
  let authDead = false;
  let nextAuthRetryAt = 0;
  let inflight: Promise<string> | null = null;

  const loadFromFile = async (): Promise<string> => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(tokenFile, 'utf8')) as unknown;
    } catch (err) {
      throw new Error(
        `fichier de tokens illisible (${tokenFile}) : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = TokenFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`fichier de tokens invalide (${tokenFile}) : clé "refreshToken" attendue`);
    }
    return parsed.data.refreshToken;
  };

  /** Écriture atomique : fichier temporaire dans le même dossier, puis `rename`. */
  const persist = async (token: string): Promise<void> => {
    const payload = `${JSON.stringify({ refreshToken: token, rotatedAt: new Date().toISOString() }, null, 2)}\n`;
    const tmp = `${tokenFile}.${randomUUID()}.tmp`;
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, tokenFile);
  };

  const markDead = (reason: string): AuthDeadError => {
    const wasDead = authDead;
    authDead = true;
    nextAuthRetryAt = Date.now() + authRetryMs;
    accessToken = null;
    if (!wasDead) {
      logger.error(AUTH_DEAD_MESSAGE, { cause: reason, tokenFile });
      options.onAuthDead?.(reason);
    }
    return new AuthDeadError(`${AUTH_DEAD_MESSAGE} (cause: ${reason})`);
  };

  const doRefresh = async (): Promise<string> => {
    // Le refresh courant vient du fichier : c'est lui la source de vérité, y
    // compris après une réécriture manuelle par l'humain. Un fichier absent ou
    // corrompu est un cas « auth morte » : aucune reprise automatique possible.
    if (refreshToken === null) {
      try {
        refreshToken = await loadFromFile();
      } catch (err) {
        throw markDead(err instanceof Error ? err.message : String(err));
      }
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    let res;
    try {
      res = await undiciFetch(`${apiUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      // Panne réseau : surtout ne pas déclarer l'auth morte, le token est intact.
      throw new Error(`refresh du token impossible (réseau) : ${String(err)}`);
    }

    const text = await res.text();
    if (!res.ok) {
      let parsedError: unknown;
      try {
        parsedError = JSON.parse(text) as unknown;
      } catch {
        parsedError = undefined;
      }
      const oauth = parsedError === undefined ? undefined : OAuthError.safeParse(parsedError);
      if (oauth?.success && FATAL_OAUTH_ERRORS.has(oauth.data.error)) {
        throw markDead(`HTTP ${res.status} ${oauth.data.error}`);
      }
      // 5xx, 429, réponse illisible : transitoire, on retentera au prochain cycle.
      throw new Error(`refresh du token refusé : HTTP ${res.status}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error('réponse /oauth2/token non JSON');
    }
    const parsed = TokenResponse.safeParse(json);
    if (!parsed.success) {
      // Pas de nouveau refresh dans la réponse : on ne sait plus où on en est.
      throw markDead('réponse /oauth2/token hors contrat (refresh_token manquant ?)');
    }

    // Persistance AVANT toute autre chose : l'ancien token est déjà mort.
    refreshToken = parsed.data.refresh_token;
    try {
      await persist(refreshToken);
    } catch (err) {
      logger.error(
        'nouveau refresh token NON persisté — au prochain redémarrage il faudra réauthentifier à la main',
        { tokenFile, error: err instanceof Error ? err.message : String(err) },
      );
    }

    accessToken = parsed.data.access_token;
    accessTokenExpiresAt = Date.now() + parsed.data.expires_in * 1_000 - expirySkewMs;
    refreshCount += 1;
    if (authDead) {
      authDead = false;
      logger.info('authentification Netatmo rétablie');
      options.onAuthRecovered?.();
    }
    logger.debug('token rafraîchi', { refreshCount, expiresInSec: parsed.data.expires_in });
    return accessToken;
  };

  /** Sérialise les rafraîchissements : deux en parallèle en tueraient un (invariant n°2). */
  const refresh = async (): Promise<string> => {
    if (inflight !== null) return inflight;
    if (authDead) {
      if (Date.now() < nextAuthRetryAt) throw new AuthDeadError(AUTH_DEAD_MESSAGE);
      // Retry doux : on relit le fichier, l'humain l'a peut-être réparé.
      nextAuthRetryAt = Date.now() + authRetryMs;
      refreshToken = null;
      logger.info('nouvelle tentative d’authentification Netatmo', { tokenFile });
    }
    const pending = doRefresh().finally(() => {
      inflight = null;
    });
    inflight = pending;
    return pending;
  };

  return {
    get authDead() {
      return authDead;
    },
    get refreshCount() {
      return refreshCount;
    },

    async load() {
      refreshToken = await loadFromFile();
    },

    async getAccessToken() {
      if (accessToken !== null && Date.now() < accessTokenExpiresAt) return accessToken;
      return refresh();
    },

    async forceRefresh() {
      accessToken = null;
      return refresh();
    },
  };
}
