import { randomUUID } from 'node:crypto';
import type { Bus, Logger } from '@stellar/bus';
import { matchTopic, type Command, type Entity, type StateTopicParts } from '@stellar/contracts';
import type { Mirror } from '../mirror.js';
import { parseHaCommandTopic, translateHaCommand } from './commands.js';
import { buildHaDiscovery, HA_COMMAND_FILTER, HA_DISCOVERY_DEFAULT_PREFIX } from './discovery.js';

/**
 * Pont HA-discovery (P8, spec §10) — **strictement unidirectionnel et jetable**
 * (ADR-003).
 *
 * Ce qu'il fait, et rien d'autre :
 *
 * - il **annonce** à Home Assistant, en retained, les entités du bus qui méritent
 *   d'exister chez lui (`homeassistant/<component>/<objectId>/config`) ;
 * - il **traduit** ce que HA publie en retour sur `home/ha/cmd/…` en `Command`
 *   `issuedBy:'voice'`, et l'envoie au driver que le miroir désigne (ADR-008).
 *
 * Ce qu'il ne fait pas : décider. Aucune règle, aucun état propre en dehors du
 * cache de déduplication. Débranché, la maison ne change pas de comportement — on
 * perd l'app mobile de secours et les intents vocaux réflexes, pas la régulation.
 *
 * **Le retained est le contrat.** Les configs ne sont pas effacées à l'arrêt du
 * core : un HA qui redémarre pendant une mise à jour du core doit retrouver ses
 * entités tout seul. Elles ne partent que quand l'entité disparaît réellement du
 * bus (retained `home/state/…` effacé).
 */

/** Un intent vocal qui n'aboutit pas en 5 s a déjà échoué pour l'utilisateur. */
export const HA_BRIDGE_COMMAND_TIMEOUT_MS = 5_000;

export interface HaBridgeOptions {
  bus: Bus;
  mirror: Mirror;
  logger: Logger;
  /** Défaut `homeassistant` — à aligner sur le `discovery_prefix` de HA s'il a été changé. */
  discoveryPrefix?: string;
  /** Défaut `HA_BRIDGE_COMMAND_TIMEOUT_MS`. */
  commandTimeoutMs?: number;
}

export interface HaBridge {
  /** Nombre de configs de découverte actuellement publiées (introspection, tests). */
  readonly published: number;
  close(): void;
}

interface PublishedConfig {
  topic: string;
  payload: string;
}

/** Clé miroir : le couple driver+id, seul identifiant unique d'une entité (cf. mirror.ts). */
const entityKey = (driver: string, entityId: string): string => `${driver}/${entityId}`;

export async function createHaBridge(options: HaBridgeOptions): Promise<HaBridge> {
  const { bus, mirror, logger } = options;
  const discoveryPrefix = options.discoveryPrefix ?? HA_DISCOVERY_DEFAULT_PREFIX;
  const commandTimeoutMs = options.commandTimeoutMs ?? HA_BRIDGE_COMMAND_TIMEOUT_MS;

  const configs = new Map<string, PublishedConfig>();
  /** Collisions d'`object_id` déjà signalées : un warn par couple, pas par message. */
  const reportedCollisions = new Set<string>();
  let closed = false;

  const publishRaw = async (topic: string, payload: string): Promise<void> => {
    await bus.client.publishAsync(topic, payload, { qos: 1, retain: true });
  };

  /**
   * (Re)publie la config d'une entité — **seulement si elle a changé**.
   *
   * La config ne dépend pas de la valeur de l'entité (cf. `buildHaDiscovery`) :
   * sans cette déduplication, chaque mesure d'un capteur réécrirait un retained
   * identique, que HA retraiterait à chaque fois.
   */
  const publishConfig = async (entity: Entity): Promise<void> => {
    if (closed) return;
    const discovery = buildHaDiscovery(entity, discoveryPrefix);
    if (discovery === null) return;

    const key = entityKey(entity.driver, entity.id);
    const payload = JSON.stringify(discovery.config);
    const known = configs.get(key);
    if (known?.topic === discovery.topic && known.payload === payload) return;

    // Deux drivers peuvent publier le même entityId (seul le couple est unique) :
    // ils se disputeraient alors le même retained de découverte. On le dit une
    // fois, sans rien casser — la vraie correction est de renommer l'entité.
    for (const [otherKey, other] of configs) {
      if (otherKey !== key && other.topic === discovery.topic) {
        const signature = [key, otherKey].sort().join('::');
        if (!reportedCollisions.has(signature)) {
          reportedCollisions.add(signature);
          logger.warn('collision de config HA entre deux entités', {
            topic: discovery.topic,
            entities: [key, otherKey],
          });
        }
      }
    }

    configs.set(key, { topic: discovery.topic, payload });
    await publishRaw(discovery.topic, payload);
    logger.debug('config HA publiée', { topic: discovery.topic, component: discovery.component });
  };

  /** Entité disparue du bus ⇒ config effacée (retained vide), sinon HA garde un fantôme. */
  const removeConfig = async (parts: StateTopicParts): Promise<void> => {
    if (closed) return;
    const key = entityKey(parts.driver, parts.entityId);
    const known = configs.get(key);
    if (known === undefined) return;
    configs.delete(key);
    await publishRaw(known.topic, '');
    logger.info('config HA effacée', { topic: known.topic });
  };

  const handleCommand = async (topic: string, raw: string): Promise<void> => {
    if (closed) return;
    const target = parseHaCommandTopic(topic);
    if (target === null) {
      logger.warn('topic de commande HA illisible, ignoré', { topic });
      return;
    }

    // ADR-008 : le driver destinataire vient du miroir, jamais d'un nom écrit ici.
    // Corollaire : une entité inconnue du miroir n'est pas commandable.
    const entity = mirror.getState(target.entityId);
    if (entity === undefined) {
      logger.warn('commande HA pour une entité inconnue du miroir, ignorée', {
        topic,
        target: target.entityId,
      });
      return;
    }

    const translated = translateHaCommand(entity.kind, target.field, raw);
    if (translated === null) {
      logger.warn('commande HA non traduisible, ignorée', {
        topic,
        target: entity.id,
        kind: entity.kind,
        field: target.field,
        payload: raw.slice(0, 80),
      });
      return;
    }

    const command: Command = {
      id: randomUUID(),
      target: entity.id,
      action: translated.action,
      params: translated.params,
      // Forcé : c'est ce qui distingue un geste vocal d'une décision de régulation
      // dans le journal (spec §10, « pourquoi la clim a tourné cette nuit ? »).
      issuedBy: 'voice',
      ts: new Date().toISOString(),
    };

    const ack = await bus.sendCommand(command, {
      driver: entity.driver,
      timeoutMs: commandTimeoutMs,
    });
    if (ack.status !== 'ok') {
      // HA n'a pas de canal d'erreur simple : on trace, et l'état retained fera foi
      // (si le driver n'a rien fait, HA reviendra tout seul à l'état réel).
      logger.warn('commande vocale non acquittée', {
        commandId: command.id,
        target: command.target,
        status: ack.status,
        ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
      });
    }
  };

  const onMessage = (topic: string, payload: Buffer): void => {
    if (!matchTopic(HA_COMMAND_FILTER, topic)) return;
    // Effacement d'un retained laissé par HA : pas une commande.
    if (payload.length === 0) return;
    void handleCommand(topic, payload.toString()).catch((err: unknown) => {
      logger.error('traitement de commande HA en échec', { topic, error: String(err) });
    });
  };

  const failed = (what: string) => (err: unknown) =>
    logger.error(what, { error: err instanceof Error ? err.message : String(err) });

  // Abonnements AVANT la relecture du miroir : une entité qui arriverait entre les
  // deux est vue par le callback, et la republication est dédupliquée de toute façon.
  await bus.onState({}, (entity) => {
    void publishConfig(entity).catch(failed('publication de config HA en échec'));
  });
  await bus.onStateDeleted((parts) => {
    void removeConfig(parts).catch(failed('effacement de config HA en échec'));
  });

  bus.client.on('message', onMessage);
  await bus.client.subscribeAsync(HA_COMMAND_FILTER, { qos: 1 });

  // Rattrapage : le miroir a pu recevoir les retained du bus avant que le pont
  // n'existe (il est monté après lui dans `createCore`).
  for (const entity of mirror.getStates()) {
    void publishConfig(entity).catch(failed('publication de config HA en échec'));
  }

  return {
    get published() {
      return configs.size;
    },
    close() {
      if (closed) return;
      closed = true;
      bus.client.removeListener('message', onMessage);
      // Les configs retained restent en place : cf. « le retained est le contrat ».
    },
  };
}
