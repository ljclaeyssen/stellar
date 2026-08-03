import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@stellar/bus';
import { startSimNetatmo, type SimNetatmo } from '@stellar/sim-netatmo';
import {
  AuthDeadError,
  createTokenStore,
  type TokenStore,
  type TokenStoreOptions,
} from './auth.js';
import { TokenFile } from './config.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * La rotation du refresh token est LE point fragile de la spec §9 : un refresh
 * raté = réauthentification manuelle. Cette suite l'exerce contre un simulateur
 * qui invalide strictement l'ancien token à chaque rotation.
 */
describe('TokenStore contre le simulateur Netatmo', () => {
  let sim: SimNetatmo;
  let tokenFile: string;

  const store = (overrides: Partial<TokenStoreOptions> = {}): TokenStore =>
    createTokenStore({
      apiUrl: sim.url,
      clientId: sim.clientId,
      clientSecret: sim.clientSecret,
      tokenFile,
      logger: silentLogger,
      // Skew nul : la durée de vie servie par le simulateur fait foi telle quelle.
      expirySkewMs: 0,
      requestTimeoutMs: 2_000,
      authRetryMs: 50,
      ...overrides,
    });

  const persistedRefreshToken = async (): Promise<string> =>
    TokenFile.parse(JSON.parse(await readFile(tokenFile, 'utf8'))).refreshToken;

  beforeEach(async () => {
    sim = await startSimNetatmo();
    tokenFile = join(tmpdir(), `stellar-netatmo-token-${randomUUID()}.json`);
    await writeFile(tokenFile, `${JSON.stringify({ refreshToken: sim.state.refreshToken })}\n`);
  });

  afterEach(async () => {
    await sim.close();
    await rm(tokenFile, { force: true });
  });

  it('persiste le refresh token courant à chaque rotation', async () => {
    const initial = sim.state.refreshToken;
    const tokens = store();

    const first = await tokens.forceRefresh();
    expect(await persistedRefreshToken()).toBe(sim.state.refreshToken);
    expect(sim.state.refreshToken).not.toBe(initial);

    const second = await tokens.forceRefresh();
    expect(second).not.toBe(first);
    expect(sim.refreshCount).toBe(2);
    // Le fichier suit la rotation : c'est LE token courant qui y est, pas l'ancien.
    expect(await persistedRefreshToken()).toBe(sim.state.refreshToken);
  });

  it('survit à un redémarrage : un nouveau store repart du fichier persisté', async () => {
    const tokens = store();
    await tokens.forceRefresh();
    await tokens.forceRefresh();

    // Redémarrage du driver : même fichier, instance neuve, aucune mémoire.
    const redemarre = store();
    await expect(redemarre.getAccessToken()).resolves.toMatch(/^access-/);
    expect(sim.refreshCount).toBe(3);
    expect(await persistedRefreshToken()).toBe(sim.state.refreshToken);
  });

  it('ne lance jamais deux rafraîchissements concurrents (ils s’entretueraient)', async () => {
    const tokens = store();
    const [a, b, c] = await Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.getAccessToken(),
    ]);
    expect(sim.refreshCount).toBe(1);
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it('rafraîchit dès que l’access token est expiré, sans y toucher avant', async () => {
    const court = await startSimNetatmo({ expiresInSeconds: 1 });
    try {
      await writeFile(tokenFile, `${JSON.stringify({ refreshToken: court.state.refreshToken })}\n`);
      const tokens = store({ apiUrl: court.url, clientId: court.clientId });
      await tokens.getAccessToken();
      await tokens.getAccessToken();
      expect(court.refreshCount).toBe(1);

      court.expireAccessToken();
      // L'expiration est côté serveur ; le store, lui, ne rafraîchit que sur 401/403
      // — c'est `forceRefresh` (appelé par l'api) qui reprend la main.
      await tokens.forceRefresh();
      expect(court.refreshCount).toBe(2);
    } finally {
      await court.close();
    }
  });

  it('refresh révoqué → auth morte, message d’action humaine, plus aucun appel réseau', async () => {
    const errors: string[] = [];
    const onAuthDead = vi.fn();
    const tokens = store({
      logger: { ...silentLogger, error: (msg) => errors.push(msg) },
      onAuthDead,
      authRetryMs: 60_000,
    });

    sim.revokeRefreshToken();
    await expect(tokens.forceRefresh()).rejects.toBeInstanceOf(AuthDeadError);
    expect(tokens.authDead).toBe(true);
    expect(errors.some((msg) => msg.includes('réauthentification manuelle requise'))).toBe(true);
    expect(onAuthDead).toHaveBeenCalledTimes(1);

    // Retry doux : tant que le délai n'est pas écoulé, on ne martèle pas l'API.
    const before = sim.refreshCount;
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthDeadError);
    expect(sim.refreshCount).toBe(before);
  });

  it('se rétablit tout seul quand l’humain réécrit le fichier de tokens', async () => {
    const onAuthRecovered = vi.fn();
    const tokens = store({ onAuthRecovered, authRetryMs: 10 });

    sim.revokeRefreshToken();
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthDeadError);

    // L'humain régénère un token sur dev.netatmo.com et réécrit le fichier.
    sim.state.refreshTokenRevoked = false;
    await writeFile(tokenFile, `${JSON.stringify({ refreshToken: sim.state.refreshToken })}\n`);

    await vi.waitFor(async () => {
      await expect(tokens.getAccessToken()).resolves.toMatch(/^access-/);
    });
    expect(tokens.authDead).toBe(false);
    expect(onAuthRecovered).toHaveBeenCalled();
  });

  it('fichier de tokens absent : message explicite, et « auth morte » au premier usage', async () => {
    await rm(tokenFile, { force: true });
    const tokens = store();
    await expect(tokens.load()).rejects.toThrow(/fichier de tokens illisible/);
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthDeadError);
    expect(tokens.authDead).toBe(true);
  });

  it('client_secret erroné : auth morte plutôt que boucle de retry', async () => {
    const tokens = store({ clientSecret: 'faux' });
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthDeadError);
    expect(tokens.authDead).toBe(true);
  });

  it('panne réseau : jamais « auth morte », le token reste intact', async () => {
    const injoignable = store({ apiUrl: 'http://127.0.0.1:1', requestTimeoutMs: 200 });
    await expect(injoignable.getAccessToken()).rejects.toThrow(/réseau/);
    expect(injoignable.authDead).toBe(false);
    expect(await persistedRefreshToken()).toBe(sim.state.refreshToken);
  });
});
