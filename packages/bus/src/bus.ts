import mqtt, { type MqttClient } from 'mqtt';
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
  safeParseEntity,
  stateTopic,
  type Entity,
  type Selector,
} from '@stellar/contracts';
import { createLogger, type Logger } from './logger.js';

export interface CreateBusOptions {
  url: string;
  clientId: string;
  driver: string;
  /** 5 par défaut (mosquitto). 4 pour les brokers sans support MQTT 5 (aedes en test). */
  protocolVersion?: 4 | 5;
  logger?: Logger;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export interface SendCommandOptions {
  /** Driver destinataire — résolu par l'appelant (le core via son miroir : entity.driver). */
  driver: string;
  timeoutMs?: number;
}

export type StateCallback = (entity: Entity, topic: string) => void;
export type EventCallback = (event: BusEvent, topic: string) => void;
export type CommandHandler = (cmd: Command) => Promise<Ack> | Ack;

export interface Bus {
  publishState(entity: Entity): Promise<void>;
  onState(selector: Selector, cb: StateCallback): Promise<void>;
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
  client.on('error', (err) => log.error('mqtt error', { error: err.message }));

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
  const eventSubs: Array<{ filter: string; cb: EventCallback }> = [];
  const pendingAcks = new Map<string, PendingAck>();
  let commandHandler: CommandHandler | null = null;

  const subscribed = new Set<string>();
  const ensureSubscribed = async (filter: string): Promise<void> => {
    if (subscribed.has(filter)) return;
    subscribed.add(filter);
    await client.subscribeAsync(filter, { qos: 1 });
  };

  const publishJson = async (
    topic: string,
    payload: unknown,
    opts: mqtt.IClientPublishOptions = {},
  ): Promise<void> => {
    await client.publishAsync(topic, JSON.stringify(payload), { qos: 1, ...opts });
  };

  const cmdFilter = cmdTopic(driver, '+');

  client.on('message', (topic, payload, packet) => {
    void (async () => {
      // Acks en attente (req/resp)
      const pending = pendingAcks.get(topic);
      if (pending) {
        const parsed = Ack.safeParse(JSON.parse(payload.toString()));
        if (!parsed.success) {
          log.warn('ack invalide, jeté', { topic });
          return;
        }
        clearTimeout(pending.timer);
        pendingAcks.delete(topic);
        pending.resolve(parsed.data);
        return;
      }

      // States
      if (matchTopic('home/state/#', topic)) {
        const parsed = safeParseEntity(JSON.parse(payload.toString()));
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
        if (!commandHandler) return;
        const parsed = Command.safeParse(JSON.parse(payload.toString()));
        if (!parsed.success) {
          log.warn('commande invalide, jetée', { topic, issues: parsed.error.issues });
          return;
        }
        const cmd = parsed.data;
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
        const responseTopic =
          (packet.properties?.responseTopic as string | undefined) ?? ackTopic(cmd.id);
        await publishJson(responseTopic, ack);
        return;
      }

      // Événements
      if (matchTopic('home/event/#', topic)) {
        const parsed = BusEvent.safeParse(JSON.parse(payload.toString()));
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

  await new Promise<void>((resolve) => client.once('connect', () => resolve()));

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

    async sendCommand(cmd, opts) {
      const valid = Command.parse(cmd);
      const timeoutMs = opts.timeoutMs ?? 5_000;
      const responseTopic = ackTopic(valid.id);
      await ensureSubscribed(responseTopic);

      const ackPromise = new Promise<Ack>((resolve) => {
        const timer = setTimeout(() => {
          pendingAcks.delete(responseTopic);
          resolve({
            commandId: valid.id,
            status: 'timeout',
            reason: `no ack after ${timeoutMs}ms`,
          });
        }, timeoutMs);
        pendingAcks.set(responseTopic, { resolve, timer });
      });

      await publishJson(cmdTopic(opts.driver, valid.target), valid, {
        properties:
          protocolVersion === 5
            ? { responseTopic, correlationData: Buffer.from(valid.id) }
            : undefined,
      });
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
      await publishJson(healthTopic(driver), {
        status: 'offline',
        ts: new Date().toISOString(),
      }, { retain: true });
      await client.endAsync();
    },
  };
}
