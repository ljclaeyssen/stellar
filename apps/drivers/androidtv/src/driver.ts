import { RemoteDirection, RemoteKeyCode } from '@kud/androidtv-remote';
import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import {
  toJsonSchema,
  type Ack,
  type Command,
  type Entity,
  type Manifest,
  type MediaValue,
} from '@stellar/contracts';
import { knownApps, resolveAppLink } from './apps.js';

export const DRIVER_NAME = 'androidtv';
export const DRIVER_VERSION = '0.1.0';

/**
 * Sous-ensemble structurel de AndroidRemote (@kud/androidtv-remote) utilisé par
 * le driver — c'est la couture qui permet un faux remote dans les tests.
 */
export interface TvRemoteLike {
  sendPower(): void;
  sendKey(keyCode: number, direction?: number): void;
  sendAppLink(link: string): void;
  sendText(text: string): void;
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'powered', listener: (powered: boolean) => void): unknown;
  on(
    event: 'volume',
    listener: (volume: { level: number; maximum: number; muted: boolean }) => void,
  ): unknown;
  on(event: 'current_app', listener: (app: string) => void): unknown;
  on(event: 'unpaired', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** Ce que le driver expose à son appelant (et aux tests) une fois démarré. */
export interface AndroidTvDriverHandle {
  /** Session Remote v2 vivante : vrai entre un `ready` et le prochain `error`/`unpaired`. */
  readonly connected: boolean;
}

const PowerParams = z.object({ on: z.boolean().optional() });
const LaunchAppParams = z.object({ app: z.string().min(1) });
const KeyParams = z.object({
  key: z.string().regex(/^KEYCODE_/, 'nom RemoteKeyCode attendu (ex. KEYCODE_HOME)'),
  direction: z.enum(['short', 'start_long', 'end_long']).default('short'),
});
const VolumeParams = z.object({ direction: z.enum(['up', 'down', 'mute']) });
const SendTextParams = z.object({ text: z.string() });

const DIRECTIONS: Record<string, number | undefined> = {
  short: RemoteDirection['SHORT'],
  start_long: RemoteDirection['START_LONG'],
  end_long: RemoteDirection['END_LONG'],
};

const VOLUME_KEYS: Record<'up' | 'down' | 'mute', string> = {
  up: 'KEYCODE_VOLUME_UP',
  down: 'KEYCODE_VOLUME_DOWN',
  mute: 'KEYCODE_VOLUME_MUTE',
};

/**
 * La lib avale silencieusement tout envoi sur une session morte (`client?.write`
 * sur socket détruit) : aucun throw, aucun ack d'erreur. Sans ce garde-fou on
 * ack `ok` une commande jamais transmise — interdit par l'ADR-009.
 */
const UNREACHABLE = 'TV injoignable (session Remote fermée)';

export interface AndroidTvDriverOptions {
  bus: Bus;
  remote: TvRemoteLike;
  entityId: string;
  room: string;
  logger: Logger;
}

export function buildManifest(entityId: string, room: string): Manifest {
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities: [{ id: entityId, kind: 'media', room }],
    commands: [
      { action: 'power', paramsSchema: toJsonSchema(PowerParams) },
      { action: 'launch_app', paramsSchema: toJsonSchema(LaunchAppParams) },
      { action: 'key', paramsSchema: toJsonSchema(KeyParams) },
      { action: 'volume', paramsSchema: toJsonSchema(VolumeParams) },
      { action: 'send_text', paramsSchema: toJsonSchema(SendTextParams) },
    ],
  };
}

/**
 * Traducteur pur : événements du protocole Remote v2 → percept `media` retained,
 * commandes du bus → appels remote. Aucune décision ici (spec, interdit n°1).
 *
 * Le driver suit la vie de la session TV (`ready` / `error` / `unpaired`) pour
 * appliquer l'ADR-009 : équipement muet ⇒ entité republiée `stale: true` et
 * commandes rejetées plutôt qu'acquittées dans le vide. La *reconnexion*, elle,
 * n'est pas de son ressort (voir `main.ts`).
 */
export async function startAndroidTvDriver(
  options: AndroidTvDriverOptions,
): Promise<AndroidTvDriverHandle> {
  const { bus, remote, entityId, room, logger } = options;

  const state: MediaValue = { power: false };
  let connected = false;

  const publish = async (): Promise<void> => {
    const entity: Entity = {
      id: entityId,
      driver: DRIVER_NAME,
      kind: 'media',
      room,
      value: { ...state },
      ts: new Date().toISOString(),
      // `stale` dérive de la session : une seule source de vérité (ADR-009).
      ...(connected ? {} : { stale: true }),
    };
    await bus.publishState(entity);
  };
  /** Une publication ratée ne doit jamais tuer le driver ni rester silencieuse. */
  const publishSafe = (): void => {
    void publish().catch((err) => logger.warn('publication state échouée', { error: String(err) }));
  };

  /** Perte de session : marquage stale immédiat, une seule fois par transition. */
  const markDisconnected = (): void => {
    if (!connected) return;
    connected = false;
    publishSafe();
  };

  remote.on('ready', () => {
    connected = true;
    logger.info('session TV établie');
    // L'entité doit exister sur le bus dès le démarrage, même avant tout
    // événement `powered` (la TV n'en émet qu'au changement d'état).
    publishSafe();
  });
  remote.on('powered', (powered) => {
    state.power = powered;
    publishSafe();
  });
  remote.on('current_app', (app) => {
    state.currentApp = app;
    publishSafe();
  });
  remote.on('volume', ({ level, maximum, muted }) => {
    state.volume = maximum > 0 ? Math.round((level / maximum) * 100) : 0;
    logger.debug('volume', { volumeLevel: level, maximum, muted });
    publishSafe();
  });
  remote.on('unpaired', () => {
    // La lib émet `unpaired` sur TOUT ECONNRESET (TV débranchée, reboot), pas
    // seulement sur révocation du certificat : ce n'est pas une erreur fatale.
    logger.warn('session TV perdue (unpaired)');
    markDisconnected();
  });
  remote.on('error', (err) => {
    logger.error('erreur protocole remote', { error: err.message });
    markDisconnected();
  });

  await bus.onCommand((cmd: Command): Ack => {
    if (cmd.target !== entityId) {
      return { commandId: cmd.id, status: 'rejected', reason: `entité inconnue: ${cmd.target}` };
    }
    const ok: Ack = { commandId: cmd.id, status: 'ok' };
    const rejected = (reason: string): Ack => ({ commandId: cmd.id, status: 'rejected', reason });

    if (!connected) return rejected(UNREACHABLE);

    switch (cmd.action) {
      case 'power': {
        const params = PowerParams.safeParse(cmd.params);
        if (!params.success) return rejected(params.error.message);
        // sendPower est un toggle : on ne l'envoie que si l'état cible diffère
        // de l'état connu (traduction d'intention, pas de logique métier).
        if (params.data.on === undefined || params.data.on !== state.power) remote.sendPower();
        return ok;
      }
      case 'launch_app': {
        const params = LaunchAppParams.safeParse(cmd.params);
        if (!params.success) return rejected(params.error.message);
        const link = resolveAppLink(params.data.app);
        if (link === undefined) {
          return rejected(
            `app inconnue: ${params.data.app} (connues: ${knownApps().join(', ')} ou deep link)`,
          );
        }
        // DoD P1 : « TV réveillée + app ouverte » — réveil si nécessaire.
        if (!state.power) {
          logger.info('réveil de la TV avant lancement', { app: params.data.app });
          remote.sendPower();
        }
        remote.sendAppLink(link);
        return ok;
      }
      case 'key': {
        const params = KeyParams.safeParse(cmd.params);
        if (!params.success) return rejected(params.error.message);
        const keyCode = RemoteKeyCode[params.data.key];
        if (keyCode === undefined) return rejected(`keycode inconnu: ${params.data.key}`);
        remote.sendKey(keyCode, DIRECTIONS[params.data.direction]);
        return ok;
      }
      case 'volume': {
        const params = VolumeParams.safeParse(cmd.params);
        if (!params.success) return rejected(params.error.message);
        const keyName = VOLUME_KEYS[params.data.direction];
        const keyCode = RemoteKeyCode[keyName];
        if (keyCode === undefined) return rejected(`keycode indisponible: ${keyName}`);
        remote.sendKey(keyCode, DIRECTIONS['short']);
        return ok;
      }
      case 'send_text': {
        const params = SendTextParams.safeParse(cmd.params);
        if (!params.success) return rejected(params.error.message);
        remote.sendText(params.data.text);
        return ok;
      }
      default:
        return rejected(`action inconnue: ${cmd.action}`);
    }
  });

  await bus.announce(buildManifest(entityId, room));
  logger.info('driver androidtv prêt', { entityId, room });

  return {
    get connected() {
      return connected;
    },
  };
}
