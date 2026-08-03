import mqtt, { type IPublishPacket, type MqttClient } from 'mqtt';
import {
  Ack,
  BusEvent,
  Command,
  Manifest,
  ackTopic,
  cmdTopic,
  discoveryTopic,
  eventTopic,
  healthTopic,
  matchTopic,
  matchesSelector,
  parseEntity,
  parseStateTopic,
  safeParseEntity,
  stateTopic,
  type Entity,
  type Selector,
  type StateTopicParts,
} from '@stellar/contracts';
import { createLogger, redactUrl, type Logger } from './logger.js';

export interface CreateBusOptions {
  url: string;
  clientId: string;
  driver: string;
  /** 5 par défaut (mosquitto). 4 pour les brokers sans support MQTT 5 (aedes en test). */
  protocolVersion?: 4 | 5;
  logger?: Logger;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /**
   * Si fourni, `createBus` rejette quand la **première** connexion n'aboutit pas
   * dans le délai (au lieu d'attendre indéfiniment que le broker apparaisse).
   * Par défaut : pas de timeout — un driver qui démarre avant le broker attend.
   */
  connectTimeoutMs?: number;
}

export interface SendCommandOptions {
  /** Driver destinataire — résolu par l'appelant (le core via son miroir : entity.driver). */
  driver: string;
  timeoutMs?: number;
}

export type StateCallback = (entity: Entity, topic: string) => void;
export type StateDeletedCallback = (parts: StateTopicParts, topic: string) => void;
export type EventCallback = (event: BusEvent, topic: string) => void;
export type CommandHandler = (cmd: Command) => Promise<Ack> | Ack;

export interface Bus {
  publishState(entity: Entity): Promise<void>;
  onState(selector: Selector, cb: StateCallback): Promise<void>;
  /** Suppression d'entité : message retained à payload vide sur `home/state/…`. */
  onStateDeleted(cb: StateDeletedCallback): Promise<void>;
  sendCommand(cmd: Command, opts: SendCommandOptions): Promise<Ack>;
  onCommand(handler: CommandHandler): Promise<void>;
  publishEvent(event: BusEvent): Promise<void>;
  onEvent(pattern: string, cb: EventCallback): Promise<void>;
  announce(manifest: Manifest): Promise<void>;
  close(): Promise<void>;
  /** Accès bas niveau (tests, outillage). */
  readonly client: MqttClient;
}

interface PendingAck {
  resolve: (ack: Ack) => void;
  timer: NodeJS.Timeout;
}

/** Filtre unique pour tous les acks attendus : une souscription pour tout le process. */
export const ACK_FILTER = 'home/ack/+';

/** Nombre de commandes récentes mémorisées pour l'idempotence (redélivrance QoS 1). */
const HANDLED_COMMANDS_MAX = 200;

/**
 * Choix du topic de réponse à une commande : response-topic MQTT 5 s'il est présent,
 * sinon le fallback `home/ack/<commandId>` (spec §6). Extrait pour être testable
 * sans broker MQTT 5.
 */
export function resolveResponseTopic(
  commandId: string,
  packet?: Pick<IPublishPacket, 'properties'>,
): string {
  const fromPacket = packet?.properties?.responseTopic;
  return typeof fromPacket === 'string' && fromPacket.length > 0 ? fromPacket : ackTopic(commandId);
}

export async function createBus(options: CreateBusOptions): Promise<Bus> {
  const { url, clientId, driver } = options;
  const protocolVersion = options.protocolVersion ?? 5;
  const log = options.logger ?? createLogger(driver);
  const reconnectMin = options.reconnectMinMs ?? 1_000;
  const reconnectMax = options.reconnectMaxMs ?? 30_000;

  const client = mqtt.connect(url, {
    clientId,
    protocolVersion,
    clean: true,
    reconnectPeriod: reconnectMin,
    will: {
      topic: healthTopic(driver),
      payload: Buffer.from(JSON.stringify({ status: 'offline', ts: new Date().toISOString() })),
      qos: 1,
      retain: true,
    },
  });

  // Backoff exponentiel : mqtt.js n'en fournit pas nativement — on ajuste
  // reconnectPeriod à chaque déconnexion, reset à la reconnexion.
  let disconnects = 0;
  client.on('close', () => {
    disconnects += 1;
    client.options.reconnectPeriod = Math.min(reconnectMax, reconnectMin * 2 ** disconnects);
  });
  const onError = (err: Error): void => log.error('mqtt error', { error: err.message });
  client.on('error', onError);

  const publishHealthOnline = (): void => {
    client.publish(
      healthTopic(driver),
      JSON.stringify({ status: 'online', ts: new Date().toISOString() }),
      { qos: 1, retain: true },
    );
  };
  client.on('connect', () => {
    disconnects = 0;
    client.options.reconnectPeriod = reconnectMin;
    publishHealthOnline();
  });

  const stateSubs: Array<{ selector: Selector; cb: StateCallback }> = [];
  const stateDeletedSubs: StateDeletedCallback[] = [];
  const eventSubs: Array<{ filter: string; cb: EventCallback }> = [];
  /** Acks en attente, keyés par commandId (pas par topic : une seule souscription). */
  const pendingAcks = new Map<string, PendingAck>();
  /** LRU des commandes déjà traitées → idempotence sur redélivrance QoS 1. */
  const handledCommands = new Map<string, Ack>();
  let commandHandler: CommandHandler | null = null;
  let closed = false;

  const subscribed = new Set<string>();
  const inflightSubs = new Map<string, Promise<void>>();
  /** Le filtre n'entre dans `subscribed` qu'une fois le SUBACK reçu. */
  const ensureSubscribed = async (filter: string): Promise<void> => {
    if (subscribed.has(filter)) return;
    const inflight = inflightSubs.get(filter);
    if (inflight) return inflight;
    const pending = client
      .subscribeAsync(filter, { qos: 1 })
      .then(() => {
        subscribed.add(filter);
      })
      .finally(() => {
        inflightSubs.delete(filter);
      });
    inflightSubs.set(filter, pending);
    return pending;
  };

  const publishJson = async (
    topic: string,
    payload: unknown,
    opts: mqtt.IClientPublishOptions = {},
  ): Promise<void> => {
    await client.publishAsync(topic, JSON.stringify(payload), { qos: 1, ...opts });
  };

  const cmdFilter = cmdTopic(driver, '+');

  const rememberCommand = (id: string, ack: Ack): void => {
    handledCommands.delete(id);
    handledCommands.set(id, ack);
    while (handledCommands.size > HANDLED_COMMANDS_MAX) {
      const oldest = handledCommands.keys().next().value;
      if (oldest === undefined) break;
      handledCommands.delete(oldest);
    }
  };

  const handleAck = (topic: string, json: unknown): void => {
    const parsed = Ack.safeParse(json);
    if (!parsed.success) {
      log.warn('ack invalide, jeté', { topic });
      return;
    }
    // Le payload fait foi ; le dernier segment du topic ne sert que de repli.
    const commandId = parsed.data.commandId;
    const pending = pendingAcks.get(commandId);
    if (!pending) {
      log.debug('ack sans commande en attente, ignoré', { topic, commandId });
      return;
    }
    clearTimeout(pending.timer);
    pendingAcks.delete(commandId);
    pending.resolve(parsed.data);
  };

  const handleCommand = async (json: unknown, packet: IPublishPacket): Promise<void> => {
    if (!commandHandler) return;
    const parsed = Command.safeParse(json);
    if (!parsed.success) {
      log.warn('commande invalide, jetée', { topic: packet.topic, issues: parsed.error.issues });
      return;
    }
    const cmd = parsed.data;
    const responseTopic = resolveResponseTopic(cmd.id, packet);

    // Redélivrance (QoS 1) : on rejoue le même ack sans réinvoquer le handler.
    const known = handledCommands.get(cmd.id);
    if (known) {
      rememberCommand(cmd.id, known);
      log.debug('commande déjà traitée, ack rejoué', { commandId: cmd.id });
      await publishJson(responseTopic, known);
      return;
    }

    let ack: Ack;
    try {
      ack = Ack.parse(await commandHandler(cmd));
    } catch (err) {
      ack = {
        commandId: cmd.id,
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    rememberCommand(cmd.id, ack);
    await publishJson(responseTopic, ack);
  };

  client.on('message', (topic, payload, packet) => {
    void (async () => {
      // Payload vide = effacement du retained (sémantique MQTT), pas une erreur.
      if (payload.length === 0) {
        const parts = parseStateTopic(topic);
        if (parts) {
          for (const cb of stateDeletedSubs) cb(parts, topic);
        } else {
          log.debug('payload vide ignoré', { topic });
        }
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(payload.toString());
      } catch {
        log.warn('payload illisible, jeté', { topic });
        return;
      }

      // Acks (req/resp) — une seule souscription `home/ack/+`, routage par commandId.
      if (matchTopic('home/ack/#', topic)) {
        handleAck(topic, json);
        return;
      }

      // States
      if (matchTopic('home/state/#', topic)) {
        const parsed = safeParseEntity(json);
        if (!parsed.success) {
          log.warn('state invalide, jeté', { topic, issues: parsed.error.issues });
          return;
        }
        for (const sub of stateSubs) {
          if (matchesSelector(parsed.data, sub.selector)) sub.cb(parsed.data, topic);
        }
        return;
      }

      // Commandes adressées à ce driver
      if (matchTopic(cmdFilter, topic)) {
        await handleCommand(json, packet);
        return;
      }

      // Événements
      if (matchTopic('home/event/#', topic)) {
        const parsed = BusEvent.safeParse(json);
        if (!parsed.success) {
          log.warn('event invalide, jeté', { topic });
          return;
        }
        for (const sub of eventSubs) {
          if (matchTopic(sub.filter, topic)) sub.cb(parsed.data, topic);
        }
      }
    })().catch((err) => log.error('erreur de dispatch message', { topic, error: String(err) }));
  });

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onConnect = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    if (options.connectTimeoutMs !== undefined) {
      timer = setTimeout(() => {
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
        client.on('error', () => undefined);
        client.end(true);
        reject(new Error(`broker injoignable: ${redactUrl(url)}`));
      }, options.connectTimeoutMs);
    }
    client.once('connect', onConnect);
  });

  return {
    client,

    async publishState(entity) {
      const valid = parseEntity(entity);
      await publishJson(stateTopic(valid.driver, valid.id), valid, { retain: true });
    },

    async onState(selector, cb) {
      stateSubs.push({ selector, cb });
      const filter =
        selector.driver && selector.id
          ? stateTopic(selector.driver, selector.id)
          : selector.driver
            ? stateTopic(selector.driver, '+')
            : 'home/state/#';
      await ensureSubscribed(filter);
    },

    async onStateDeleted(cb) {
      stateDeletedSubs.push(cb);
      await ensureSubscribed('home/state/#');
    },

    async sendCommand(cmd, opts) {
      const valid = Command.parse(cmd);
      const timeoutMs = opts.timeoutMs ?? 5_000;
      const responseTopic = ackTopic(valid.id);

      // Le timer est armé AVANT toute I/O : broker injoignable ⇒ ack 'timeout' quand même.
      const ackPromise = new Promise<Ack>((resolve) => {
        const timer = setTimeout(() => {
          pendingAcks.delete(valid.id);
          resolve({
            commandId: valid.id,
            status: 'timeout',
            reason: `no ack after ${timeoutMs}ms`,
          });
        }, timeoutMs);
        pendingAcks.set(valid.id, { resolve, timer });
      });

      void (async () => {
        await ensureSubscribed(ACK_FILTER);
        await publishJson(cmdTopic(opts.driver, valid.target), valid, {
          properties:
            protocolVersion === 5
              ? { responseTopic, correlationData: Buffer.from(valid.id) }
              : undefined,
        });
      })().catch((err) =>
        // Rejet possible APRÈS le timeout (client fermé, broker down) : jamais fatal.
        log.debug('envoi de commande en échec', { commandId: valid.id, error: String(err) }),
      );

      return ackPromise;
    },

    async onCommand(handler) {
      commandHandler = handler;
      await ensureSubscribed(cmdFilter);
    },

    async publishEvent(event) {
      const valid = BusEvent.parse(event);
      await publishJson(eventTopic(valid.driver, valid.type), valid);
    },

    async onEvent(pattern, cb) {
      const filter = `home/event/${pattern}`;
      eventSubs.push({ filter, cb });
      await ensureSubscribed(filter);
    },

    async announce(manifest) {
      const valid = Manifest.parse(manifest);
      await publishJson(discoveryTopic(valid.driver), valid, { retain: true });
      publishHealthOnline();
    },

    async close() {
      if (closed) return;
      closed = true;

      for (const pending of pendingAcks.values()) clearTimeout(pending.timer);
      pendingAcks.clear();

      // À l'arrêt, un 'write after end' n'est pas une erreur exploitable : on
      // neutralise le listener (mais on en garde un, sinon EventEmitter throw).
      client.removeListener('error', onError);
      client.on('error', () => undefined);

      // best effort : si le broker est parti, le LWT fera le travail — on ne bloque pas.
      if (client.connected) {
        await Promise.race([
          publishJson(
            healthTopic(driver),
            { status: 'offline', ts: new Date().toISOString() },
            { retain: true },
          ).catch(() => undefined),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 500);
            t.unref?.();
          }),
        ]);
      }

      // Déconnexion propre si on est connecté, forcée sinon (un DISCONNECT écrit
      // dans un socket mort ne rappellerait jamais son callback). Timer de sécurité
      // pour qu'un `close()` ne bloque jamais l'arrêt du process.
      await new Promise<void>((resolve) => {
        const guard = setTimeout(() => {
          client.end(true);
          resolve();
        }, 2_000);
        guard.unref?.();
        client.end(!client.connected, () => {
          clearTimeout(guard);
          resolve();
        });
      });
    },
  };
}
