import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import type { Command, Entity } from '@stellar/contracts';
import { createCore, type Core } from '../core.js';
import type { JournalRow } from '../journal.js';
import { createSubscriptionRegistry } from './subscriptions.js';

/**
 * INTÉGRATION DU SERVEUR MCP (P7) — vrai broker, vrai transport, vrai client.
 *
 * Le test parle au core exactement comme le fera `apps/agent` : un client MCP du
 * SDK officiel, en HTTP streamable, sur le port éphémère du core. Rien n'est
 * appelé « en process » — sinon on ne testerait ni le transport, ni la validation
 * des entrées, ni la forme des erreurs, qui sont précisément ce que le serveur
 * MCP ajoute au core.
 *
 * Le monde : un faux driver de clim (`fakeclim`, qui acquitte) et un faux driver
 * d'ouvrants (`fakeouvrants`, qui publie une serrure et un volet et n'est *jamais*
 * censé recevoir quoi que ce soit — c'est la preuve du garde-fou).
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const CLIM_DRIVER = 'fakeclim';
const OPENING_DRIVER = 'fakeouvrants';

const PROD_CONFIG = fileURLToPath(new URL('../../../../config/regulation.yaml', import.meta.url));

/** Les 5 tools de la spec §10 + `poll_subscription` (forme MCP du subscribe) + le bonus §11. */
const EXPECTED_TOOLS = [
  'get_regulation_config',
  'get_state',
  'list_capabilities',
  'poll_subscription',
  'query_journal',
  'send_command',
  'subscribe',
];

interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

interface CapabilityReport {
  driver: string;
  version: string | null;
  entities: { id: string; kind: string }[];
  commands: { action: string }[];
  health: { status: string } | null;
}

describe('serveur MCP du core', () => {
  let broker: TestBroker;
  let climBus: Bus;
  let openingBus: Bus;
  let coreBus: Bus;
  let core: Core;
  let client: Client;

  /** Commandes réellement reçues par chaque faux driver — la preuve du routage. */
  const climCommands: Command[] = [];
  const openingCommands: Command[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    // `callTool` rend l'union CallToolResult | résultat de compatibilité : on
    // resserre sur la forme moderne, la seule que ce serveur produise.
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('');
    return {
      isError: result.isError === true,
      text,
      data: result.structuredContent ?? {},
    };
  };

  const publishClimate = async (targetTemp: number): Promise<void> => {
    await climBus.publishState({
      id: 'clim_salon',
      driver: CLIM_DRIVER,
      kind: 'climate',
      room: 'salon',
      value: { power: true, mode: 'heat', targetTemp, indoorTemp: 19.5, fan: 'auto' },
      ts: new Date().toISOString(),
    });
  };

  const publishTemp = async (celsius: number): Promise<void> => {
    await climBus.publishState({
      id: 'temp_salon',
      driver: CLIM_DRIVER,
      kind: 'temperature',
      room: 'salon',
      value: celsius,
      unit: '°C',
      ts: new Date().toISOString(),
    });
  };

  const commandRows = (entityId: string): JournalRow[] =>
    core.journal.query({ entityId, limit: 500 }).filter((row) => row.topic.startsWith('home/cmd/'));

  beforeAll(async () => {
    broker = await startTestBroker();

    climBus = await createBus({
      url: broker.url,
      clientId: 'mcp-clim',
      driver: CLIM_DRIVER,
      protocolVersion: 4,
      logger,
    });
    await climBus.onCommand((cmd) => {
      climCommands.push(cmd);
      return { commandId: cmd.id, status: 'ok' };
    });

    openingBus = await createBus({
      url: broker.url,
      clientId: 'mcp-ouvrants',
      driver: OPENING_DRIVER,
      protocolVersion: 4,
      logger,
    });
    await openingBus.onCommand((cmd) => {
      openingCommands.push(cmd);
      return { commandId: cmd.id, status: 'ok' };
    });

    coreBus = await createBus({
      url: broker.url,
      clientId: 'mcp-core',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });
    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      // Ni détection stale ni régulation : le sujet ici est la façade MCP, et un
      // tour de régulation ajouterait des commandes `issuedBy:'core'` au journal.
      staleCheckIntervalMs: 3_600_000,
      mcp: { port: 0, regulationConfigPath: PROD_CONFIG },
    });

    await climBus.announce({
      driver: CLIM_DRIVER,
      version: '9.9.9',
      entities: [
        { id: 'clim_salon', kind: 'climate', room: 'salon' },
        { id: 'temp_salon', kind: 'temperature', room: 'salon', unit: '°C' },
      ],
      commands: [{ action: 'set', paramsSchema: { type: 'object' } }],
    });
    await publishClimate(20);
    await publishTemp(18.5);
    await openingBus.publishState({
      id: 'serrure_entree',
      driver: OPENING_DRIVER,
      kind: 'lock',
      room: 'entree',
      value: { locked: true },
      ts: new Date().toISOString(),
    });
    await openingBus.publishState({
      id: 'volet_salon',
      driver: OPENING_DRIVER,
      kind: 'cover',
      room: 'salon',
      value: { position: 100 },
      ts: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(core.mirror.getStates()).toHaveLength(4);
      expect(core.mirror.getManifests().size).toBeGreaterThan(0);
    });

    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(core.mcp?.url ?? 'http://127.0.0.1:0/mcp')),
    );
  });

  afterAll(async () => {
    await client.close();
    await coreBus.close();
    await climBus.close();
    await openingBus.close();
    await core.close();
    await broker.close();
  });

  it('publie les tools de la spec, tous décrits et schématisés', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    // Les schémas viennent bien des contrats, pas d'une redéfinition locale.
    const getState = tools.find((tool) => tool.name === 'get_state');
    expect(Object.keys(getState?.inputSchema.properties ?? {}).sort()).toEqual([
      'driver',
      'id',
      'kind',
      'room',
    ]);
  });

  it('get_state rend les entités du sélecteur kind + room', async () => {
    const result = await call('get_state', { kind: 'climate', room: 'salon' });

    expect(result.isError).toBe(false);
    const entities = result.data['entities'] as Entity[];
    expect(entities.map((entity) => entity.id)).toEqual(['clim_salon']);
    expect(entities[0]?.room).toBe('salon');

    const empty = await call('get_state', { kind: 'climate', room: 'cave' });
    expect((empty.data['entities'] as Entity[]).length).toBe(0);
  });

  it('list_capabilities reflète le manifeste et la santé du faux driver', async () => {
    const result = await call('list_capabilities');

    expect(result.isError).toBe(false);
    const drivers = result.data['drivers'] as CapabilityReport[];
    const clim = drivers.find((entry) => entry.driver === CLIM_DRIVER);
    expect(clim?.version).toBe('9.9.9');
    expect(clim?.entities.map((entity) => entity.id).sort()).toEqual(['clim_salon', 'temp_salon']);
    expect(clim?.commands.map((command) => command.action)).toEqual(['set']);
    expect(clim?.health?.status).toBe('online');
  });

  it('send_command atteint le driver avec issuedBy agent, et le journal le dit', async () => {
    const result = await call('send_command', {
      target: 'clim_salon',
      action: 'set',
      params: { power: true, targetTemp: 21 },
    });

    expect(result.isError).toBe(false);
    expect(result.data['status']).toBe('ok');

    const received = climCommands.at(-1);
    expect(received?.target).toBe('clim_salon');
    expect(received?.action).toBe('set');
    expect(received?.params).toEqual({ power: true, targetTemp: 21 });
    // Le cœur du garde-fou de provenance : l'appelant n'a jamais pu choisir.
    expect(received?.issuedBy).toBe('agent');
    expect(received?.id).toBe(result.data['commandId']);

    await vi.waitFor(() => {
      const rows = commandRows('clim_salon');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.issuedBy === 'agent')).toBe(true);
    });
  });

  it('refuse une entité de kind lock — et rien ne part sur le bus', async () => {
    const result = await call('send_command', {
      target: 'serrure_entree',
      action: 'unlock',
      params: {},
    });

    expect(result.isError).toBe(true);
    expect(result.data['code']).toBe('forbidden_kind');
    expect(result.data['kind']).toBe('lock');
    expect(result.text).toContain('refusée');

    // Absence : ni le driver ni le journal (qui voit tout `home/cmd/#`) n'ont vu
    // passer quoi que ce soit. Le délai laisse au broker le temps de démentir.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openingCommands).toEqual([]);
    expect(commandRows('serrure_entree')).toEqual([]);
  });

  it('refuse aussi les kinds réservés tant qu’aucun contrat ne les définit', async () => {
    const result = await call('send_command', { target: 'volet_salon', action: 'open' });

    expect(result.isError).toBe(true);
    expect(result.data['code']).toBe('forbidden_kind');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openingCommands).toEqual([]);
    expect(commandRows('volet_salon')).toEqual([]);
  });

  it('refuse une entité absente du miroir', async () => {
    const result = await call('send_command', { target: 'clim_grenier', action: 'set' });

    expect(result.isError).toBe(true);
    expect(result.data['code']).toBe('unknown_entity');
    expect(climCommands.some((cmd) => cmd.target === 'clim_grenier')).toBe(false);
  });

  it('subscribe puis poll_subscription rendent les changements accumulés', async () => {
    const subscription = await call('subscribe', { kind: 'temperature', room: 'salon' });
    expect(subscription.isError).toBe(false);
    const subscriptionId = subscription.data['subscriptionId'] as string;
    expect(subscription.data['bufferSize']).toBe(200);

    // Rien ne s'est produit depuis l'abonnement : le relevé est vide, pas en erreur.
    const empty = await call('poll_subscription', { subscriptionId });
    expect(empty.isError).toBe(false);
    expect(empty.data['changes']).toEqual([]);

    await publishTemp(19);
    await publishTemp(20);
    await publishTemp(21);
    await vi.waitFor(() => expect(core.mirror.getState('temp_salon')?.value).toBe(21));

    const poll = await call('poll_subscription', { subscriptionId });
    const changes = poll.data['changes'] as Entity[];
    expect(changes.map((entity) => entity.value)).toEqual([19, 20, 21]);
    expect(poll.data['dropped']).toBe(0);

    // Un relevé vide le tampon : le suivant ne rejoue pas les mêmes changements.
    const again = await call('poll_subscription', { subscriptionId });
    expect(again.data['changes']).toEqual([]);
  });

  it('poll_subscription refuse proprement un identifiant inconnu', async () => {
    const result = await call('poll_subscription', {
      subscriptionId: '00000000-0000-4000-8000-000000000000',
    });

    expect(result.isError).toBe(true);
    expect(result.data['code']).toBe('unknown_subscription');
  });

  it('query_journal filtre par entityId', async () => {
    const result = await call('query_journal', { entityId: 'clim_salon', limit: 50 });

    expect(result.isError).toBe(false);
    const rows = result.data['rows'] as JournalRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.entityId === 'clim_salon')).toBe(true);
    expect(rows.some((row) => row.topic.startsWith('home/cmd/'))).toBe(true);
    expect(rows.some((row) => row.topic.startsWith('home/state/'))).toBe(true);

    const other = await call('query_journal', { entityId: 'temp_salon', limit: 50 });
    expect((other.data['rows'] as JournalRow[]).every((row) => row.entityId === 'temp_salon')).toBe(
      true,
    );
  });

  it('get_regulation_config rend la configuration validée, en lecture seule', async () => {
    const result = await call('get_regulation_config');

    expect(result.isError).toBe(false);
    const config = result.data['config'] as { rooms: Record<string, unknown>; hysteresis: number };
    expect(Object.keys(config.rooms)).toContain('salon');
    expect(typeof config.hysteresis).toBe('number');
    // Aucun tool d'écriture ici : `propose_regulation_change` vit dans l'agent.
    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name.includes('set') || tool.name.includes('propose'))).toBe(
      false,
    );
  });

  describe('entrées invalides', () => {
    it('refuse toute entrée hors contrat sans tuer le serveur', async () => {
      const rejections = await Promise.all([
        // `licorne` n'est pas un Kind ;
        call('get_state', { kind: 'licorne' }),
        // `action` est obligatoire ;
        call('send_command', { target: 'clim_salon' }),
        // un subscriptionId est un uuid ;
        call('poll_subscription', { subscriptionId: 'pas-un-uuid' }),
        // et `entiteId` est une faute de frappe, pas une extension : le filtre du
        // journal est strict, sinon l'agent croirait avoir filtré.
        call('query_journal', { entiteId: 'clim_salon' }),
        call('tool_inexistant'),
      ]);

      for (const rejection of rejections) {
        expect(rejection.isError).toBe(true);
        expect(rejection.text).toContain('MCP error');
      }

      // Le serveur répond toujours, et le monde n'a pas bougé.
      const after = await call('get_state', { kind: 'climate' });
      expect(after.isError).toBe(false);
      expect((after.data['entities'] as Entity[]).length).toBe(1);
      expect(climCommands.every((cmd) => cmd.target === 'clim_salon')).toBe(true);
    });
  });
});

/**
 * Le tampon d'abonnement se teste sans broker ni transport : ses bornes (taille,
 * TTL, nombre d'abonnements) sont de l'arithmétique, et un test d'intégration qui
 * publierait 250 états pour la démontrer serait long sans rien prouver de plus.
 */
describe('registre d’abonnements', () => {
  const entity = (value: number, room = 'salon'): Entity => ({
    id: `temp_${room}`,
    driver: 'capteur',
    kind: 'temperature',
    room,
    value,
    ts: new Date().toISOString(),
  });

  it('borne le tampon en FIFO et compte les changements perdus', () => {
    const registry = createSubscriptionRegistry({ bufferSize: 3 });
    const { subscriptionId } = registry.create({ kind: 'temperature' });

    for (const value of [1, 2, 3, 4, 5]) registry.record(entity(value));

    const poll = registry.poll(subscriptionId);
    expect(poll?.changes.map((change) => change.value)).toEqual([3, 4, 5]);
    expect(poll?.dropped).toBe(2);
    // Le compteur repart à zéro avec le tampon.
    expect(registry.poll(subscriptionId)?.dropped).toBe(0);
  });

  it('ne range que ce qui correspond au sélecteur', () => {
    const registry = createSubscriptionRegistry();
    const { subscriptionId } = registry.create({ room: 'chambre' });

    registry.record(entity(20, 'salon'));
    registry.record(entity(18, 'chambre'));

    expect(registry.poll(subscriptionId)?.changes.map((change) => change.room)).toEqual([
      'chambre',
    ]);
  });

  it('oublie un abonnement qui n’est plus relevé', () => {
    let now = 0;
    const registry = createSubscriptionRegistry({ ttlMs: 1_000, clock: () => now });
    const { subscriptionId } = registry.create({});

    now = 500;
    expect(registry.poll(subscriptionId)).toBeDefined();

    now = 2_000;
    expect(registry.poll(subscriptionId)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('plafonne le nombre d’abonnements en évinçant le moins récent', () => {
    let now = 0;
    const registry = createSubscriptionRegistry({ maxSubscriptions: 2, clock: () => now });
    const first = registry.create({ room: 'salon' }).subscriptionId;
    now = 1;
    const second = registry.create({ room: 'chambre' }).subscriptionId;

    now = 2;
    registry.poll(second);
    now = 3;
    const third = registry.create({ room: 'entree' }).subscriptionId;

    expect(registry.size).toBe(2);
    expect(registry.poll(first)).toBeUndefined();
    expect(registry.poll(second)).toBeDefined();
    expect(registry.poll(third)).toBeDefined();
  });
});
