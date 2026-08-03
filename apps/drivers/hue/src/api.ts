import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { z } from 'zod';
import type { Logger } from '@stellar/bus';
import {
  HueDevice,
  HueEnvelope,
  HueEvent,
  HueLight,
  HueResourceUpdate,
  HueRoom,
  type HueLightPatch,
} from './clipv2.js';

/** Flux d'événements ouvert — `close()` est idempotent et arrête toute reconnexion. */
export interface HueEventStream {
  close(): void;
}

/**
 * Couture du driver avec le bridge (ADR-010 niveau 1) : tout ce que le driver
 * sait faire du matériel passe par cette interface. Les tests la doublent —
 * ici par le simulateur CLIP v2 réel (`@stellar/sim-hue`), niveau 2.
 */
export interface HueApiLike {
  getLights(): Promise<HueLight[]>;
  getDevices(): Promise<HueDevice[]>;
  getRooms(): Promise<HueRoom[]>;
  setLight(id: string, patch: HueLightPatch): Promise<void>;
  /**
   * Ouvre le flux SSE et le maintient (reconnexion backoff expo interne).
   * `onDown`/`onUp` portent la sémantique « équipement muet » de l'ADR-009 :
   * le driver n'a rien d'autre à surveiller.
   */
  openEventStream(
    onEvent: (updates: HueResourceUpdate[]) => void,
    onDown: (reason: string) => void,
    onUp: () => void,
  ): HueEventStream;
}

export interface HueApiOptions {
  /** `https://192.168.1.10` (bridge réel) ou `http://localhost:8842` (simulateur). */
  baseUrl: string;
  applicationKey: string;
  logger: Logger;
  /** Backoff de reconnexion du flux SSE — 1 s → 30 s par défaut (règle spec §9). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Timeout des requêtes REST (inventaire, PUT). */
  requestTimeoutMs?: number;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Découpe un flux SSE en événements. Rappelle `onData` avec la concaténation des
 * lignes `data:` à chaque ligne vide. Les commentaires (`: keep-alive`) et le
 * champ `id:` ne servent à rien ici et sont ignorés.
 *
 * Fonction pure et exportée : les frontières de trame arrivent n'importe où dans
 * les chunks TCP, c'est exactement le genre de détail qu'on veut testable seul.
 */
export function createSseDecoder(onData: (data: string) => void): (chunk: string) => void {
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      dataLines = [];
      onData(data);
    }
  };

  return (chunk: string): void => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line === '') flush();
      else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') dataLines.push(value);
      }
      index = buffer.indexOf('\n');
    }
  };
}

/**
 * Le bridge présente un certificat autosigné (son propre CA, CN = bridge id) :
 * aucune chaîne publique ne le valide. On désactive donc la vérification —
 * **uniquement pour ce dispatcher, donc uniquement pour les appels au bridge**,
 * jamais globalement (`NODE_TLS_REJECT_UNAUTHORIZED` interdit : il ouvrirait
 * tout le process). LAN only, zéro port ouvert (spec §14).
 */
export function createBridgeDispatcher(baseUrl: string): Dispatcher | undefined {
  if (!baseUrl.startsWith('https:')) return undefined;
  return new Agent({ connect: { rejectUnauthorized: false } });
}

export function createHueApi(options: HueApiOptions): HueApiLike {
  const { applicationKey, logger } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const reconnectMin = options.reconnectMinMs ?? 1_000;
  const reconnectMax = options.reconnectMaxMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const dispatcher = createBridgeDispatcher(baseUrl);

  const headers = { 'hue-application-key': applicationKey };

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await undiciFetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${method} ${path} → réponse non JSON`);
    }
  };

  /** Enveloppe illisible ⇒ erreur (l'inventaire serait faux) ; ressource isolée invalide ⇒ sautée. */
  // `ZodType<T, ZodTypeDef, unknown>` et non `ZodType<T>` : avec des `.default()`
  // dans le schéma, l'entrée n'a pas la forme de la sortie.
  const getResources = async <T>(
    resource: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T[]> => {
    const json = await request('GET', `/clip/v2/resource/${resource}`);
    const envelope = HueEnvelope.safeParse(json);
    if (!envelope.success) {
      throw new Error(`réponse /${resource} hors contrat CLIP v2`);
    }
    if (envelope.data.errors.length > 0) {
      logger.warn('le bridge signale des erreurs', {
        resource,
        count: envelope.data.errors.length,
      });
    }
    const out: T[] = [];
    for (const item of envelope.data.data) {
      const parsed = schema.safeParse(item);
      if (!parsed.success) {
        logger.warn('ressource CLIP v2 inattendue, ignorée', {
          resource,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }
      out.push(parsed.data);
    }
    return out;
  };

  return {
    getLights: () => getResources('light', HueLight),
    getDevices: () => getResources('device', HueDevice),
    getRooms: () => getResources('room', HueRoom),

    async setLight(id, patch) {
      await request('PUT', `/clip/v2/resource/light/${encodeURIComponent(id)}`, patch);
    },

    openEventStream(onEvent, onDown, onUp) {
      let stopped = false;
      let attempt = 0;
      let controller: AbortController | null = null;

      const handleData = (data: string): void => {
        let json: unknown;
        try {
          json = JSON.parse(data) as unknown;
        } catch {
          logger.warn('événement SSE illisible, ignoré');
          return;
        }
        const events = Array.isArray(json) ? json : [json];
        const updates: HueResourceUpdate[] = [];
        for (const raw of events) {
          const event = HueEvent.safeParse(raw);
          if (!event.success) {
            logger.warn('événement SSE hors contrat, ignoré');
            continue;
          }
          if (event.data.type !== 'update') continue;
          for (const item of event.data.data) {
            const update = HueResourceUpdate.safeParse(item);
            if (!update.success) {
              logger.warn('ressource d’événement inattendue, ignorée');
              continue;
            }
            if (update.data.type !== undefined && update.data.type !== 'light') continue;
            updates.push(update.data);
          }
        }
        if (updates.length > 0) onEvent(updates);
      };

      const runOnce = async (): Promise<void> => {
        controller = new AbortController();
        const res = await undiciFetch(`${baseUrl}/eventstream/clip/v2`, {
          headers: { ...headers, accept: 'text/event-stream' },
          dispatcher,
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) {
          throw new Error(`event stream → HTTP ${res.status}`);
        }
        attempt = 0;
        logger.info('event stream ouvert');
        onUp();
        // Les types undici exposent le corps en `ReadableStream<any>` : on le
        // rétablit en octets, sinon tout le décodage devient `any`.
        const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const decoder = new TextDecoder();
        const feed = createSseDecoder(handleData);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
        throw new Error('event stream fermé par le bridge');
      };

      const loop = async (): Promise<void> => {
        while (!stopped) {
          try {
            await runOnce();
          } catch (err) {
            if (stopped) return;
            const reason = err instanceof Error ? err.message : String(err);
            onDown(reason);
            const delayMs = Math.min(reconnectMax, reconnectMin * 2 ** attempt);
            attempt += 1;
            logger.warn('bridge injoignable, nouvelle tentative', { reason, delayMs, attempt });
            await wait(delayMs);
          }
        }
      };
      void loop();

      return {
        close() {
          stopped = true;
          controller?.abort();
        },
      };
    },
  };
}
