import type { Bus, Logger } from '@stellar/bus';
import type { Entity } from '@stellar/contracts';
import { buildManifest, type DeviceMapping, type MappingIndex } from './mapping-table.js';
import { normalizeDevice, type Percept } from './normalize.js';

/**
 * Le normalizer est le « driver » des topics `home/state/z2m/…` : c'est lui qui
 * signe les entités, pas Zigbee2MQTT. Un objet Zigbee qui change de passerelle
 * ne doit pas changer d'identité sur le bus.
 */
export const DRIVER_NAME = 'z2m';
export const DRIVER_VERSION = '0.1.0';
export const DEFAULT_BASE_TOPIC = 'zigbee2mqtt';

const AVAILABILITY_SUFFIX = '/availability';
/** Topics Z2M *entrants* (écrits par des clients) : jamais des états à traduire. */
const IGNORED_SUFFIXES = ['/set', '/get'];

export interface Z2mNormalizerOptions {
  bus: Bus;
  index: MappingIndex;
  logger: Logger;
  /** Racine des topics Z2M (`Z2M_BASE_TOPIC`, défaut `zigbee2mqtt`). */
  baseTopic?: string;
}

export interface Z2mNormalizerHandle {
  /** friendlyName vus sur le bus mais absents de la table — le chemin d'extensibilité. */
  readonly unmapped: readonly string[];
  /** Devices annoncés `offline` par Z2M et dont les entités sont marquées stale. */
  readonly offline: readonly string[];
  /** Dernier percept connu par entité : la mémoire minimale nécessaire au stale (ADR-009). */
  readonly lastPercepts: ReadonlyMap<string, Percept>;
  /** Attend le traitement des messages déjà reçus (tests, arrêt propre). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `{"state":"online"}` (Z2M ≥ 1.28) ou la chaîne brute `online` (versions
 * antérieures, et `legacy_availability_payload: true`). Les deux existent dans
 * la nature : le driver lit les deux plutôt que d'imposer une version de Z2M.
 */
export function parseAvailability(raw: string): boolean | null {
  const text = raw.trim();
  if (text === 'online') return true;
  if (text === 'offline') return false;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const state =
    typeof json === 'string'
      ? json
      : json !== null && typeof json === 'object'
        ? (json as { state?: unknown }).state
        : undefined;
  if (state === 'online') return true;
  if (state === 'offline') return false;
  return null;
}

/**
 * Traducteur pur Zigbee2MQTT → contrats Stellar.
 *
 * Z2M publie sur **le même broker** que le bus : le driver s'abonne donc en brut
 * à `<base>/#` via le client MQTT du bus, plutôt que d'ouvrir une seconde
 * connexion. Ce qu'il fait de chaque message est entièrement dicté par la table
 * (`config/z2m-mapping.json`) — aucune connaissance de modèle en dur, aucune
 * décision (interdit n°1).
 *
 * Ce qu'il ne fait **pas**, volontairement :
 * - fabriquer du `stale` sur un simple silence : un capteur Zigbee sur pile peut
 *   se taire des heures sans être mort. Le seuil par kind est un choix de
 *   régulation, il appartient au core (spec §10, P5). Seule une annonce
 *   `availability: offline` de Z2M — une information, pas une déduction —
 *   déclenche un `stale: true` ici ;
 * - republier de façon optimiste au retour en ligne : on attend un vrai payload.
 */
export async function startZ2mNormalizer(
  options: Z2mNormalizerOptions,
): Promise<Z2mNormalizerHandle> {
  const { bus, index, logger } = options;
  const baseTopic = options.baseTopic ?? DEFAULT_BASE_TOPIC;
  const filter = `${baseTopic}/#`;

  const lastPercepts = new Map<string, Percept>();
  const perceptsByDevice = new Map<string, Set<string>>();
  const offlineDevices = new Set<string>();
  const unmappedSeen = new Set<string>();
  /** Sérialise le traitement : l'ordre des messages Z2M porte du sens (payload puis offline). */
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const toEntity = (percept: Percept, stale: boolean): Entity => ({
    id: percept.entityId,
    driver: DRIVER_NAME,
    kind: percept.kind,
    ...(percept.room === undefined ? {} : { room: percept.room }),
    ...(percept.unit === undefined ? {} : { unit: percept.unit }),
    value: percept.value,
    ts: new Date().toISOString(),
    ...(stale ? { stale: true } : {}),
  });

  const publish = async (percept: Percept, stale: boolean): Promise<void> => {
    await bus.publishState(toEntity(percept, stale)).catch((err: unknown) => {
      logger.warn('publication state échouée', {
        entityId: percept.entityId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  /** Un friendlyName inconnu se signale **une fois** : c'est une invitation, pas une alarme. */
  const noteUnmapped = (friendlyName: string): void => {
    if (unmappedSeen.has(friendlyName)) return;
    unmappedSeen.add(friendlyName);
    logger.info(
      `device Zigbee non mappé : ${friendlyName} — ajouter une ligne à config/z2m-mapping.json`,
      { friendlyName },
    );
  };

  const handleState = async (device: DeviceMapping, raw: Buffer): Promise<void> => {
    if (raw.length === 0) {
      logger.debug('payload Z2M vide ignoré', { friendlyName: device.friendlyName });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      logger.warn('payload Z2M illisible, jeté', { friendlyName: device.friendlyName });
      return;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      logger.warn('payload Z2M inattendu (objet JSON attendu), jeté', {
        friendlyName: device.friendlyName,
      });
      return;
    }

    const outcome = normalizeDevice(device, json as Record<string, unknown>);
    for (const skipped of outcome.skipped) {
      // Cas nominal : Z2M ne republie que les attributs reçus.
      logger.debug('champ absent du payload, entité non publiée', {
        friendlyName: device.friendlyName,
        ...skipped,
      });
    }
    for (const rejected of outcome.rejected) {
      logger.warn('valeur hors contrat, entité non publiée (état précédent conservé)', {
        friendlyName: device.friendlyName,
        ...rejected,
      });
    }
    if (outcome.percepts.length === 0) return;

    // Un payload frais lève le doute posé par une annonce `offline`.
    if (offlineDevices.delete(device.friendlyName)) {
      logger.info('device de nouveau bavard, entités republiées fraîches', {
        friendlyName: device.friendlyName,
      });
    }

    const owned = perceptsByDevice.get(device.friendlyName) ?? new Set<string>();
    perceptsByDevice.set(device.friendlyName, owned);
    for (const percept of outcome.percepts) {
      lastPercepts.set(percept.entityId, percept);
      owned.add(percept.entityId);
    }
    await Promise.all(outcome.percepts.map((percept) => publish(percept, false)));
  };

  const handleAvailability = async (friendlyName: string, raw: Buffer): Promise<void> => {
    const online = parseAvailability(raw.toString());
    if (online === null) {
      logger.warn('availability Z2M illisible, ignorée', {
        friendlyName,
        payload: raw.toString().slice(0, 80),
      });
      return;
    }

    if (online) {
      // Pas de republication optimiste : on ne sait rien tant qu'un payload n'arrive pas.
      if (offlineDevices.delete(friendlyName)) {
        logger.info('device annoncé online, en attente d’un payload frais', { friendlyName });
      }
      return;
    }

    if (offlineDevices.has(friendlyName)) return;
    offlineDevices.add(friendlyName);

    const owned = perceptsByDevice.get(friendlyName);
    if (owned === undefined || owned.size === 0) {
      logger.debug('device annoncé offline, aucune entité connue à marquer stale', {
        friendlyName,
      });
      return;
    }
    logger.warn('device annoncé offline par Z2M, entités marquées stale (ADR-009)', {
      friendlyName,
      entities: [...owned],
    });
    await Promise.all(
      [...owned].map(async (entityId) => {
        const percept = lastPercepts.get(entityId);
        if (percept !== undefined) await publish(percept, true);
      }),
    );
  };

  const route = async (topic: string, raw: Buffer): Promise<void> => {
    if (closed) return;
    if (topic !== baseTopic && !topic.startsWith(`${baseTopic}/`)) return;
    const relative = topic.slice(baseTopic.length + 1);
    if (relative === '') return;

    // `<base>/bridge/#` : logs, état et config de la passerelle — hors contrat.
    if (relative === 'bridge' || relative.startsWith('bridge/')) {
      logger.debug('topic bridge Z2M ignoré', { topic });
      return;
    }

    const device = index.byFriendlyName.get(relative);
    if (device !== undefined) {
      await handleState(device, raw);
      return;
    }

    if (relative.endsWith(AVAILABILITY_SUFFIX)) {
      const friendlyName = relative.slice(0, -AVAILABILITY_SUFFIX.length);
      if (index.byFriendlyName.has(friendlyName)) {
        await handleAvailability(friendlyName, raw);
      } else {
        noteUnmapped(friendlyName);
      }
      return;
    }

    if (IGNORED_SUFFIXES.some((suffix) => relative.endsWith(suffix))) {
      logger.debug('topic Z2M entrant ignoré', { topic });
      return;
    }

    noteUnmapped(relative);
  };

  const onMessage = (topic: string, raw: Buffer): void => {
    queue = queue.then(() =>
      route(topic, raw).catch((err: unknown) => {
        logger.error('traitement d’un message Z2M échoué', {
          topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  };

  bus.client.on('message', onMessage);
  await bus.client.subscribeAsync(filter, { qos: 1 });
  await bus.announce(buildManifest(index, DRIVER_NAME, DRIVER_VERSION));

  logger.info('driver z2m-normalizer prêt', {
    baseTopic,
    devices: index.byFriendlyName.size,
    entities: index.entityIds.length,
  });

  return {
    get unmapped() {
      return [...unmappedSeen];
    },
    get offline() {
      return [...offlineDevices];
    },
    lastPercepts,
    async drain() {
      await queue;
    },
    async close() {
      closed = true;
      bus.client.removeListener('message', onMessage);
      await queue;
      if (bus.client.connected) {
        await bus.client
          .unsubscribeAsync(filter)
          .catch((err: unknown) => logger.debug('unsubscribe Z2M', { error: String(err) }));
      }
    },
  };
}
