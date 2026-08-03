import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import type { Logger } from '@stellar/bus';
import { createBridgeDispatcher } from './api.js';
import { HuePairingResponse } from './clipv2.js';

/** Le bridge répond ceci tant que le bouton physique n'a pas été pressé. */
const LINK_BUTTON_NOT_PRESSED = 101;

export interface PairOptions {
  /** Intervalle entre deux tentatives (le bridge tolère ~1 requête/s). */
  intervalMs?: number;
  /** Abandon au bout de ce délai — le bouton n'ouvre la fenêtre que ~30 s. */
  timeoutMs?: number;
}

export interface PairResult {
  applicationKey: string;
  clientKey?: string;
  keyFile: string;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Pairing CLIP v2, une fois pour toutes : on POSTe `/api` en boucle, le bridge
 * répond « link button not pressed » (erreur 101) jusqu'à l'appui sur son bouton
 * physique, puis délivre l'application key — persistée en JSON local.
 *
 * Boucle plutôt qu'un essai unique : personne ne peut appuyer sur le bouton et
 * lancer la commande dans la même seconde.
 */
export async function pair(
  bridgeUrl: string,
  keyFile: string,
  logger: Logger,
  options: PairOptions = {},
): Promise<PairResult> {
  const intervalMs = options.intervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const baseUrl = bridgeUrl.replace(/\/+$/, '');
  const dispatcher = createBridgeDispatcher(baseUrl);
  const deadline = Date.now() + timeoutMs;

  logger.info(
    `appuie sur le bouton du bridge Hue (${Math.round(timeoutMs / 1000)} s pour le faire)`,
  );

  let announced = false;
  for (;;) {
    let payload: unknown;
    try {
      const res = await undiciFetch(`${baseUrl}/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ devicetype: 'stellar#core', generateclientkey: true }),
        dispatcher,
        signal: AbortSignal.timeout(5_000),
      });
      payload = await res.json();
    } catch (err) {
      logger.warn('bridge injoignable, nouvelle tentative', { error: String(err) });
      payload = undefined;
    }

    const parsed = payload === undefined ? undefined : HuePairingResponse.safeParse(payload);
    if (parsed?.success) {
      const success = parsed.data.find((entry) => entry.success !== undefined)?.success;
      if (success) {
        const result: PairResult = {
          applicationKey: success.username,
          ...(success.clientkey === undefined ? {} : { clientKey: success.clientkey }),
          keyFile,
        };
        await mkdir(dirname(keyFile), { recursive: true });
        await writeFile(
          keyFile,
          `${JSON.stringify(
            {
              applicationKey: result.applicationKey,
              ...(result.clientKey === undefined ? {} : { clientKey: result.clientKey }),
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        logger.info('pairing réussi, application key persistée', { keyFile });
        logger.warn('penser à chiffrer ce fichier avec sops/age avant tout backup');
        return result;
      }
      const error = parsed.data.find((entry) => entry.error !== undefined)?.error;
      if (error && error.type !== LINK_BUTTON_NOT_PRESSED) {
        throw new Error(`pairing refusé par le bridge: ${error.description}`);
      }
      if (error && !announced) {
        announced = true;
        logger.info('le bridge attend l’appui sur son bouton…');
      }
    } else if (parsed) {
      logger.warn('réponse de pairing hors contrat, nouvelle tentative');
    }

    if (Date.now() + intervalMs >= deadline) {
      throw new Error(
        `pairing abandonné après ${Math.round(timeoutMs / 1000)} s — bouton du bridge non pressé ou bridge injoignable (${baseUrl})`,
      );
    }
    await wait(intervalMs);
  }
}
