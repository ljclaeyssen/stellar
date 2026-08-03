import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';

/**
 * Simulateur Zigbee2MQTT — ADR-010 niveau 2.
 *
 * Ce n'est **pas** un serveur : Z2M n'expose pas d'API, il publie sur le même
 * broker MQTT que le bus. Le simulateur est donc un simple *publisher* qui
 * rejoue des fixtures sur `zigbee2mqtt/<friendly_name>` (état) et
 * `zigbee2mqtt/<friendly_name>/availability` (présence radio), au rythme voulu.
 *
 * Ce qu'il reproduit fidèlement, et qui compte pour le normalizer :
 * - le **payload JSON à plat** de Z2M, et son caractère **partiel** (Z2M ne
 *   republie que les attributs reçus — d'où `publishOnce(name, patch)`) ;
 * - l'**availability** dans ses **deux formats** : `{"state":"online"}` (Z2M ≥ 1.28)
 *   et la chaîne brute `online` (versions antérieures) — retained, comme Z2M ;
 * - le **silence** d'un device (`stopDevice`) : une pile morte ne publie pas
 *   d'availability `offline`, elle se tait. C'est le core (P5) qui en tire une
 *   conclusion, pas le driver.
 */

export type Z2mPayload = Record<string, unknown>;

export interface SimZ2mDeviceSpec {
  friendlyName: string;
  /** Payload initial. Prioritaire sur `payloadFile`. */
  payload?: Z2mPayload;
  /** Fixture JSON — chemin absolu, ou relatif à `fixturesDir`. */
  payloadFile?: string;
  /** Période de republication quand `start()` tourne (défaut : `defaultPeriodMs`). */
  periodMs?: number;
}

/** Z2M a changé de format en cours de route : le driver doit gérer les deux. */
export type AvailabilityFormat = 'json' | 'legacy';

export interface SimZ2mOptions {
  url: string;
  clientId?: string;
  /** Racine des topics Z2M (défaut `zigbee2mqtt`). */
  baseTopic?: string;
  /** Racine de résolution des `payloadFile` relatifs (défaut : cwd). */
  fixturesDir?: string;
  devices?: readonly SimZ2mDeviceSpec[];
  /** Rythme par défaut de `start()` — 10 s, comme un capteur Zigbee bavard. */
  defaultPeriodMs?: number;
  availabilityFormat?: AvailabilityFormat;
  /** 4 pour aedes (tests), 5 pour mosquitto. */
  protocolVersion?: 4 | 5;
  /** Z2M ne retient l'état que si `retain: true` est configuré — défaut : non. */
  retainState?: boolean;
  /** Journal JSON — silencieux par défaut (usage en test). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface SimZ2m {
  readonly url: string;
  readonly baseTopic: string;
  readonly deviceNames: readonly string[];
  /** Copie du payload courant d'un device (l'état interne reste au simulateur). */
  payloadOf(name: string): Z2mPayload;
  /** Ajoute un device à chaud — le pendant simulateur d'un appairage Zigbee. */
  addDevice(spec: SimZ2mDeviceSpec): Promise<void>;
  /** Publie l'état courant, après fusion optionnelle d'un patch (payload partiel). */
  publishOnce(name: string, patch?: Z2mPayload): Promise<void>;
  /** Démarre la republication périodique de tous les devices connus. */
  start(): void;
  /** Le device se tait (pile morte) — sans annoncer quoi que ce soit. */
  stopDevice(name: string): void;
  /** Change un attribut et le publie immédiatement, comme un capteur qui rapporte. */
  setField(name: string, field: string, value: unknown): Promise<void>;
  setAvailability(name: string, online: boolean, format?: AvailabilityFormat): Promise<void>;
  close(): Promise<void>;
}

interface SimDevice {
  friendlyName: string;
  payload: Z2mPayload;
  periodMs: number;
  timer?: NodeJS.Timeout;
}

const DEFAULT_BASE_TOPIC = 'zigbee2mqtt';
const DEFAULT_PERIOD_MS = 10_000;

async function loadPayload(spec: SimZ2mDeviceSpec, fixturesDir: string): Promise<Z2mPayload> {
  if (spec.payload !== undefined) return { ...spec.payload };
  if (spec.payloadFile === undefined) {
    throw new Error(`sim-z2m: device « ${spec.friendlyName} » sans payload ni payloadFile`);
  }
  const file = isAbsolute(spec.payloadFile)
    ? spec.payloadFile
    : resolve(fixturesDir, spec.payloadFile);
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`sim-z2m: fixture ${file} n'est pas un objet JSON`);
  }
  return { ...(parsed as Z2mPayload) };
}

export async function startSimZ2m(options: SimZ2mOptions): Promise<SimZ2m> {
  const baseTopic = options.baseTopic ?? DEFAULT_BASE_TOPIC;
  const fixturesDir = options.fixturesDir ?? process.cwd();
  const defaultPeriodMs = options.defaultPeriodMs ?? DEFAULT_PERIOD_MS;
  const defaultAvailabilityFormat = options.availabilityFormat ?? 'json';
  const retainState = options.retainState ?? false;
  const log = options.log ?? ((): void => undefined);

  const client: MqttClient = mqtt.connect(options.url, {
    clientId: options.clientId ?? `sim-z2m-${Math.random().toString(16).slice(2, 10)}`,
    protocolVersion: options.protocolVersion ?? 4,
    clean: true,
  });
  // Un broker qui tombe pendant un test ne doit pas faire throw un EventEmitter nu.
  client.on('error', (err: Error) => log({ msg: 'erreur mqtt', error: err.message }));
  await new Promise<void>((resolve_, reject) => {
    const onError = (err: Error): void => reject(err);
    client.once('error', onError);
    client.once('connect', () => {
      client.removeListener('error', onError);
      resolve_();
    });
  });

  const devices = new Map<string, SimDevice>();
  let started = false;
  let closed = false;

  const require_ = (name: string): SimDevice => {
    const device = devices.get(name);
    if (device === undefined) throw new Error(`sim-z2m: device inconnu « ${name} »`);
    return device;
  };

  const publishState = async (device: SimDevice): Promise<void> => {
    if (closed) return;
    await client.publishAsync(
      `${baseTopic}/${device.friendlyName}`,
      JSON.stringify(device.payload),
      {
        qos: 1,
        retain: retainState,
      },
    );
    log({ msg: 'état publié', device: device.friendlyName });
  };

  const scheduleDevice = (device: SimDevice): void => {
    if (device.timer !== undefined) clearInterval(device.timer);
    device.timer = setInterval(() => {
      void publishState(device).catch((err: unknown) =>
        log({
          msg: 'publication périodique échouée',
          device: device.friendlyName,
          error: String(err),
        }),
      );
    }, device.periodMs);
  };

  const setAvailability = async (
    name: string,
    online: boolean,
    format?: AvailabilityFormat,
  ): Promise<void> => {
    const device = require_(name);
    const state = online ? 'online' : 'offline';
    const chosen = format ?? defaultAvailabilityFormat;
    await client.publishAsync(
      `${baseTopic}/${device.friendlyName}/availability`,
      chosen === 'json' ? JSON.stringify({ state }) : state,
      { qos: 1, retain: true },
    );
    log({ msg: 'availability publiée', device: device.friendlyName, state, format: chosen });
  };

  const addDevice = async (spec: SimZ2mDeviceSpec): Promise<void> => {
    const device: SimDevice = {
      friendlyName: spec.friendlyName,
      payload: await loadPayload(spec, fixturesDir),
      periodMs: spec.periodMs ?? defaultPeriodMs,
    };
    devices.set(device.friendlyName, device);
    // Z2M annonce la disponibilité d'un device dès qu'il le connaît.
    await setAvailability(device.friendlyName, true);
    if (started) scheduleDevice(device);
  };

  for (const spec of options.devices ?? []) await addDevice(spec);

  return {
    url: options.url,
    baseTopic,
    get deviceNames() {
      return [...devices.keys()];
    },

    payloadOf(name) {
      return { ...require_(name).payload };
    },

    addDevice,

    async publishOnce(name, patch) {
      const device = require_(name);
      if (patch !== undefined) Object.assign(device.payload, patch);
      await publishState(device);
    },

    start() {
      started = true;
      for (const device of devices.values()) scheduleDevice(device);
    },

    stopDevice(name) {
      const device = require_(name);
      if (device.timer !== undefined) {
        clearInterval(device.timer);
        device.timer = undefined;
      }
      log({ msg: 'device muet (plus aucune publication)', device: name });
    },

    async setField(name, field, value) {
      const device = require_(name);
      device.payload[field] = value;
      await publishState(device);
    },

    setAvailability,

    async close() {
      if (closed) return;
      closed = true;
      for (const device of devices.values()) {
        if (device.timer !== undefined) clearInterval(device.timer);
        device.timer = undefined;
      }
      await new Promise<void>((resolve_) => {
        const guard = setTimeout(() => {
          client.end(true);
          resolve_();
        }, 2_000);
        guard.unref?.();
        client.end(!client.connected, () => {
          clearTimeout(guard);
          resolve_();
        });
      });
    },
  };
}
