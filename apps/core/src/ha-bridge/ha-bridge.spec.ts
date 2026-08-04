import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import type { Command } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { createCore, type Core } from '../core.js';

/**
 * INTÉGRATION DU PONT HA-DISCOVERY (P8) — vrai broker, vrais retained.
 *
 * Le test se met à la place de Home Assistant : il ne connaît du core que ce qui
 * transite par MQTT. Il s'abonne à `homeassistant/#` **après** que tout a été
 * publié (c'est ce que fait un HA qui démarre après le core) et vérifie qu'il
 * retrouve la maison entière ; puis il publie des commandes exactement comme HA
 * le ferait, et regarde ce que le faux driver reçoit.
 *
 * Le monde : un faux driver unique qui publie une lampe, une prise, une sonde,
 * une clim… et une serrure, qui n'a rien à faire chez HA.
 */

const DRIVER = 'fakemaison';
const PREFIX = 'homeassistant';

interface Warning {
  msg: string;
  extra?: Record<string, unknown>;
}

const warnings: Warning[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, extra) => {
    warnings.push({ msg, ...(extra !== undefined ? { extra } : {}) });
  },
  error: () => undefined,
};

interface HaMessage {
  topic: string;
  payload: string;
}

describe('pont HA-discovery', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let coreBus: Bus;
  /** Le « Home Assistant » du test : abonné tardif à `homeassistant/#`. */
  let haBus: Bus;
  let core: Core;

  const haMessages: HaMessage[] = [];
  const driverCommands: Command[] = [];

  const messagesFor = (objectId: string): HaMessage[] =>
    haMessages.filter((message) => message.topic.endsWith(`/${objectId}/config`));

  const configOf = (objectId: string): Record<string, unknown> => {
    const messages = messagesFor(objectId);
    const last = messages[messages.length - 1];
    if (last === undefined) throw new Error(`aucune config publiée pour ${objectId}`);
    return JSON.parse(last.payload) as Record<string, unknown>;
  };

  const topicOf = (objectId: string): string => {
    const messages = messagesFor(objectId);
    return messages[messages.length - 1]?.topic ?? '';
  };

  const publishLight = async (on: boolean, brightness: number): Promise<void> => {
    await driverBus.publishState({
      id: 'light_salon',
      driver: DRIVER,
      kind: 'light',
      room: 'salon',
      value: { on, brightness },
      ts: new Date().toISOString(),
    });
  };

  const publishClimate = async (targetTemp: number): Promise<void> => {
    await driverBus.publishState({
      id: 'clim_salon',
      driver: DRIVER,
      kind: 'climate',
      room: 'salon',
      value: { power: true, mode: 'heat', targetTemp, indoorTemp: 19.5, fan: 'auto' },
      ts: new Date().toISOString(),
    });
  };

  /** Publication brute : c'est HA qui parle, pas un composant du bus. */
  const haPublish = async (topic: string, payload: string): Promise<void> => {
    await driverBus.client.publishAsync(topic, payload, { qos: 1 });
  };

  const lastCommand = (): Command | undefined => driverCommands[driverCommands.length - 1];

  beforeAll(async () => {
    broker = await startTestBroker();

    driverBus = await createBus({
      url: broker.url,
      clientId: 'ha-driver',
      driver: DRIVER,
      protocolVersion: 4,
      logger,
    });
    await driverBus.onCommand((cmd) => {
      driverCommands.push(cmd);
      return { commandId: cmd.id, status: 'ok' };
    });

    coreBus = await createBus({
      url: broker.url,
      clientId: 'ha-core',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });
    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      mcp: { enabled: false },
      staleCheckIntervalMs: 3_600_000,
      haBridge: {},
    });

    await publishLight(true, 60);
    await driverBus.publishState({
      id: 'plug_tv',
      driver: DRIVER,
      kind: 'plug',
      room: 'salon',
      value: { on: false },
      ts: new Date().toISOString(),
    });
    await driverBus.publishState({
      id: 'temp_salon',
      driver: DRIVER,
      kind: 'temperature',
      room: 'salon',
      value: 19.2,
      unit: '°C',
      ts: new Date().toISOString(),
    });
    await publishClimate(20);
    // La serrure : publiée sur le bus, jamais annoncée à HA (spec §4 n°1).
    await driverBus.publishState({
      id: 'serrure_entree',
      driver: DRIVER,
      kind: 'lock',
      room: 'entree',
      value: { locked: true },
      ts: new Date().toISOString(),
    });

    await vi.waitFor(
      () => {
        expect(core.mirror.getStates()).toHaveLength(5);
        expect(core.haBridge?.published).toBe(4);
      },
      { timeout: 5_000 },
    );

    // HA démarre APRÈS le core : tout ce qu'il apprend vient des retained.
    haBus = await createBus({
      url: broker.url,
      clientId: 'ha-spy',
      driver: 'haspy',
      protocolVersion: 4,
      logger,
    });
    haBus.client.on('message', (topic, payload) => {
      if (!topic.startsWith(`${PREFIX}/`)) return;
      haMessages.push({ topic, payload: payload.toString() });
    });
    await haBus.client.subscribeAsync(`${PREFIX}/#`, { qos: 1 });

    await vi.waitFor(() => expect(haMessages).toHaveLength(4), { timeout: 5_000 });
  });

  afterAll(async () => {
    await haBus.close();
    await driverBus.close();
    await coreBus.close();
    await core.close();
    await broker.close();
  });

  it('sert à un HA démarré après coup les configs retained de toutes les entités exposées', () => {
    expect(haMessages.map((message) => message.topic).sort()).toEqual([
      `${PREFIX}/climate/stellar_clim_salon/config`,
      `${PREFIX}/light/stellar_light_salon/config`,
      `${PREFIX}/sensor/stellar_temp_salon/config`,
      `${PREFIX}/switch/stellar_plug_tv/config`,
    ]);
  });

  it('mappe une lampe sur nos topics, avec identité, disponibilité et pièce', () => {
    const config = configOf('stellar_light_salon');

    expect(config['unique_id']).toBe('stellar_light_salon');
    expect(config['state_topic']).toBe(`home/state/${DRIVER}/light_salon`);
    expect(config['state_value_template']).toContain('value_json.value.on');
    expect(config['command_topic']).toBe('home/ha/cmd/light_salon');
    expect(config['payload_on']).toBe('true');
    expect(config['payload_off']).toBe('false');

    // La luminosité de notre contrat est en % : on l'annonce, on ne la convertit pas.
    expect(config['brightness_scale']).toBe(100);
    expect(config['brightness_state_topic']).toBe(`home/state/${DRIVER}/light_salon`);
    expect(config['brightness_command_topic']).toBe('home/ha/cmd/light_salon/brightness');
    expect(config['brightness_value_template']).toContain('value_json.value.brightness');

    // Disponibilité = LWT du driver ; attributs = fraîcheur + pièce.
    expect(config['availability_topic']).toBe(`home/health/${DRIVER}`);
    expect(config['availability_template']).toContain('value_json.status');
    expect(config['json_attributes_topic']).toBe(`home/state/${DRIVER}/light_salon`);
    expect(config['json_attributes_template']).toContain('stale');

    // Regroupement par pièce : ce qui rend « la lumière du salon » adressable.
    expect(config['device']).toMatchObject({ identifiers: ['stellar_salon'], name: 'salon' });
  });

  it('mappe une prise en switch et une sonde en sensor typé', () => {
    const plug = configOf('stellar_plug_tv');
    expect(topicOf('stellar_plug_tv')).toBe(`${PREFIX}/switch/stellar_plug_tv/config`);
    expect(plug['command_topic']).toBe('home/ha/cmd/plug_tv');
    expect(plug['value_template']).toContain('value_json.value.on');
    expect(plug['state_on']).toBe('true');

    const temp = configOf('stellar_temp_salon');
    expect(topicOf('stellar_temp_salon')).toBe(`${PREFIX}/sensor/stellar_temp_salon/config`);
    expect(temp['device_class']).toBe('temperature');
    expect(temp['unit_of_measurement']).toBe('°C');
    expect(temp['value_template']).toBe('{{ value_json.value }}');
    // Un capteur ne se commande pas : aucun topic de commande.
    expect(temp['command_topic']).toBeUndefined();
  });

  it('mappe une clim en climate : température courante, consigne et modes traduits', () => {
    const config = configOf('stellar_clim_salon');

    expect(config['current_temperature_topic']).toBe(`home/state/${DRIVER}/clim_salon`);
    expect(config['current_temperature_template']).toContain('value_json.value.indoorTemp');
    expect(config['temperature_state_template']).toContain('value_json.value.targetTemp');
    expect(config['temperature_command_topic']).toBe('home/ha/cmd/clim_salon/temperature');
    expect(config['mode_command_topic']).toBe('home/ha/cmd/clim_salon/mode');
    // `power:false` ⇒ `off`, et notre `fan` ⇒ leur `fan_only` : traduction, pas logique.
    expect(config['modes']).toEqual(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']);
    expect(config['mode_state_template']).toContain('fan_only');
    expect(config['mode_state_template']).toContain('off');
  });

  it("n'annonce jamais une entité de sécurité à HA", () => {
    expect(core.mirror.getState('serrure_entree')).toBeDefined();
    expect(haMessages.filter((message) => message.topic.includes('serrure'))).toHaveLength(0);
  });

  it('ne republie pas la config quand seule la valeur de l’entité change', async () => {
    expect(messagesFor('stellar_clim_salon')).toHaveLength(1);

    await publishClimate(21);
    await publishClimate(22);
    await publishLight(false, 10);

    // Une entité neuve sert de jalon : quand SA config est arrivée, celles qui
    // devaient éventuellement être republiées le seraient déjà.
    await driverBus.publishState({
      id: 'temp_chambre',
      driver: DRIVER,
      kind: 'temperature',
      room: 'chambre',
      value: 17.4,
      unit: '°C',
      ts: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(messagesFor('stellar_temp_chambre')).toHaveLength(1), {
      timeout: 5_000,
    });

    expect(messagesFor('stellar_clim_salon')).toHaveLength(1);
    expect(messagesFor('stellar_light_salon')).toHaveLength(1);
  });

  it('traduit une commande HA en Command issuedBy voice adressée au bon driver', async () => {
    await haPublish('home/ha/cmd/light_salon', 'true');

    await vi.waitFor(() => expect(lastCommand()?.target).toBe('light_salon'), { timeout: 5_000 });
    expect(lastCommand()).toMatchObject({
      target: 'light_salon',
      action: 'set',
      params: { on: true },
      issuedBy: 'voice',
    });
  });

  it('traduit la consigne et le mode d’une clim', async () => {
    await haPublish('home/ha/cmd/clim_salon/temperature', '21.5');
    await vi.waitFor(() => expect(lastCommand()?.target).toBe('clim_salon'), { timeout: 5_000 });
    expect(lastCommand()?.params).toEqual({ targetTemp: 21.5 });

    await haPublish('home/ha/cmd/clim_salon/mode', '"fan_only"');
    await vi.waitFor(() => expect(lastCommand()?.params).toEqual({ power: true, mode: 'fan' }), {
      timeout: 5_000,
    });

    await haPublish('home/ha/cmd/clim_salon/mode', '"off"');
    await vi.waitFor(() => expect(lastCommand()?.params).toEqual({ power: false }), {
      timeout: 5_000,
    });
  });

  it('ignore un payload HA intraduisible, en le disant', async () => {
    const before = driverCommands.length;
    warnings.length = 0;

    await haPublish('home/ha/cmd/light_salon', '"allumee"');
    await haPublish('home/ha/cmd/clim_salon/temperature', '"chaud"');
    await haPublish('home/ha/cmd/serrure_entree', 'true');
    await haPublish('home/ha/cmd/entite_inconnue', 'true');

    // Jalon : une commande valide publiée après les mauvaises. Quand elle arrive,
    // les précédentes ont forcément été traitées (même client, même ordre QoS 1).
    await haPublish('home/ha/cmd/plug_tv', 'true');
    await vi.waitFor(() => expect(lastCommand()?.target).toBe('plug_tv'), { timeout: 5_000 });

    expect(driverCommands).toHaveLength(before + 1);
    expect(warnings.filter((warning) => warning.msg.includes('non traduisible'))).toHaveLength(3);
    expect(warnings.filter((warning) => warning.msg.includes('inconnue du miroir'))).toHaveLength(
      1,
    );
  });

  it('efface la config quand l’entité disparaît du bus', async () => {
    // Retained effacé = l'entité n'existe plus (sémantique MQTT, cf. mirror.ts).
    await driverBus.client.publishAsync(`home/state/${DRIVER}/plug_tv`, '', {
      qos: 1,
      retain: true,
    });

    await vi.waitFor(() => expect(messagesFor('stellar_plug_tv')).toHaveLength(2), {
      timeout: 5_000,
    });
    expect(messagesFor('stellar_plug_tv')[1]?.payload).toBe('');
    expect(core.haBridge?.published).toBe(4);
  });
});

describe('pont HA-discovery absent par défaut', () => {
  let broker: TestBroker;
  let driverBus: Bus;
  let coreBus: Bus;
  let core: Core;

  const haMessages: string[] = [];

  beforeAll(async () => {
    broker = await startTestBroker();
    driverBus = await createBus({
      url: broker.url,
      clientId: 'nobridge-driver',
      driver: DRIVER,
      protocolVersion: 4,
      logger,
    });
    coreBus = await createBus({
      url: broker.url,
      clientId: 'nobridge-core',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });
    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      mcp: { enabled: false },
      staleCheckIntervalMs: 3_600_000,
    });

    driverBus.client.on('message', (topic) => {
      if (topic.startsWith(`${PREFIX}/`)) haMessages.push(topic);
    });
    await driverBus.client.subscribeAsync(`${PREFIX}/#`, { qos: 1 });

    await driverBus.publishState({
      id: 'light_cuisine',
      driver: DRIVER,
      kind: 'light',
      room: 'cuisine',
      value: { on: true, brightness: 100 },
      ts: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(core.mirror.getStates()).toHaveLength(1), { timeout: 5_000 });
  });

  afterAll(async () => {
    await driverBus.close();
    await coreBus.close();
    await core.close();
    await broker.close();
  });

  it("n'annonce rien tant que l'option n'est pas donnée", () => {
    expect(core.haBridge).toBeNull();
    expect(haMessages).toHaveLength(0);
  });
});
