import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { CoverValue, type Entity } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { startFakeShutterDriver, type FakeShutterHandle } from '@stellar/driver-fake-shutter';
import { createCore, type Core } from './core.js';
import { haCommandTopic, haObjectId, HA_FIELD } from './ha-bridge/index.js';
import type { JournalRow } from './journal.js';

/**
 * TEST D'ACCEPTANCE D'EXTENSIBILITÉ (P9, spec §13) — « brancher à chaud un
 * fake-shutter-driver → il apparaît dans les capacités et se pilote, **sans
 * qu'aucun commit n'ait touché core/agent** ».
 *
 * Le scénario est joué dans cet ordre, et l'ordre est le sujet :
 *
 * 1. un core **complet** démarre (miroir, journal, MCP, pont HA) sur un broker
 *    vide — il ne connaît alors aucun volet, et le test le vérifie ;
 * 2. **ensuite seulement**, le driver est branché, exactement comme le serait un
 *    process lancé six mois plus tard : son package, son bus, son manifeste ;
 * 3. tout ce que la maison sait faire d'un volet est alors exercé par les portes
 *    d'entrée réelles — un client MCP officiel pour l'agent, un topic
 *    `home/ha/cmd/…` pour la voix.
 *
 * La dernière assertion est la plus importante : elle relit les sources de
 * `apps/core` et `apps/agent` et exige qu'aucune n'ait jamais entendu parler de ce
 * driver. Le test se vérifie donc lui-même — le jour où quelqu'un « fait marcher »
 * l'extensibilité en écrivant un cas particulier dans le core, il devient rouge.
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Identité de l'équipement branché à chaud — **une donnée de test**, jamais du code de core. */
const DRIVER = 'fake-shutter';
const ENTITY_ID = 'volet_salon';
const ROOM = 'salon';

/** Ce dossier (`apps/core/src`) et la racine du dépôt, déduits de ce fichier. */
const CORE_SRC = fileURLToPath(new URL('./', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

interface CapabilityReport {
  driver: string;
  version: string | null;
  entities: { id: string; kind: string; room?: string }[];
  commands: { action: string }[];
  health: { status: string } | null;
}

describe('extensibilité P9 : un volet branché à chaud', () => {
  let broker: TestBroker;
  let coreBus: Bus;
  let core: Core;
  /** Tient le rôle de Home Assistant : un process tiers qui publie sur `home/ha/cmd/…`. */
  let haBus: Bus;
  let driverBus: Bus;
  let shutter: FakeShutterHandle;
  let client: Client;

  /** Ce que le core savait AVANT que le driver n'existe — la moitié de la démonstration. */
  let statesBeforeDriver = -1;
  let manifestsBeforeDriver = -1;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return {
      isError: result.isError === true,
      text: (result.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join(''),
      data: result.structuredContent ?? {},
    };
  };

  /**
   * Lit un message **retained** avec un client neuf : c'est la seule façon de
   * prouver que l'état survit à l'abonné (spec §6, « magasin d'états gratuit »).
   */
  const readRetained = async (topic: string): Promise<string> => {
    const reader = await createBus({
      url: broker.url,
      clientId: `p9-reader-${Math.random().toString(36).slice(2)}`,
      driver: 'p9-reader',
      protocolVersion: 4,
      logger,
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`aucun retained sur ${topic}`)), 5_000);
        reader.client.on('message', (received, payload) => {
          if (received !== topic || payload.length === 0) return;
          clearTimeout(timer);
          resolve(payload.toString());
        });
        void reader.client.subscribeAsync(topic, { qos: 1 });
      });
    } finally {
      await reader.close();
    }
  };

  /** Commandes réellement parties sur le bus pour cette entité, telles que journalisées. */
  const commandRows = (): JournalRow[] =>
    core.journal
      .query({ entityId: ENTITY_ID, limit: 500 })
      .filter((row) => row.topic.startsWith('home/cmd/'));

  const coverState = (): CoverValue => {
    const entity = core.mirror.getState(ENTITY_ID);
    if (entity === undefined) throw new Error('volet absent du miroir');
    return CoverValue.parse(entity.value);
  };

  beforeAll(async () => {
    broker = await startTestBroker();
    coreBus = await createBus({
      url: broker.url,
      clientId: 'p9-core',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });

    // Un core COMPLET : miroir, journal, serveur MCP (port éphémère) et pont
    // HA-discovery. Pas de régulation ni de veille stale : elles ajouteraient des
    // commandes `issuedBy:'core'` et des republications au scénario.
    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      staleCheckIntervalMs: 3_600_000,
      mcp: { port: 0 },
      haBridge: {},
    });

    haBus = await createBus({
      url: broker.url,
      clientId: 'p9-ha',
      driver: 'home-assistant',
      protocolVersion: 4,
      logger,
    });

    // Photo de l'ignorance du core, prise avant que le driver n'existe.
    statesBeforeDriver = core.mirror.getStates().length;
    manifestsBeforeDriver = core.mirror.getManifests().size;

    // ── Branchement à chaud, six mois plus tard ──────────────────────────────
    driverBus = await createBus({
      url: broker.url,
      clientId: 'p9-fake-shutter',
      driver: DRIVER,
      protocolVersion: 4,
      logger,
    });
    shutter = await startFakeShutterDriver({
      bus: driverBus,
      entityId: ENTITY_ID,
      room: ROOM,
      // Course complète en 100 ms : le scénario observe le mouvement sans l'attendre.
      speedMs: 5,
      logger,
    });

    await vi.waitFor(() => {
      expect(core.mirror.getState(ENTITY_ID)).toBeDefined();
      expect(core.mirror.getManifests().get(DRIVER)).toBeDefined();
    });

    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(core.mcp?.url ?? 'http://127.0.0.1:0/mcp')),
    );
  });

  afterAll(async () => {
    await client.close();
    shutter.close();
    await driverBus.close();
    await haBus.close();
    await coreBus.close();
    await core.close();
    await broker.close();
  });

  it('1. le core démarre sans rien savoir du volet, puis le découvre seul', async () => {
    expect(statesBeforeDriver).toBe(0);
    expect(manifestsBeforeDriver).toBe(0);

    const result = await call('list_capabilities');
    expect(result.isError).toBe(false);

    const drivers = result.data['drivers'] as CapabilityReport[];
    const discovered = drivers.find((entry) => entry.driver === DRIVER);
    expect(discovered).toBeDefined();
    expect(discovered?.entities).toContainEqual(
      expect.objectContaining({ id: ENTITY_ID, kind: 'cover', room: ROOM }),
    );
    expect(discovered?.commands.map((command) => command.action)).toEqual(['set']);
    expect(discovered?.health?.status).toBe('online');
  });

  it('2. get_state le retrouve par sélecteur kind + room, avec un value conforme', async () => {
    const result = await call('get_state', { kind: 'cover', room: ROOM });

    expect(result.isError).toBe(false);
    const entities = result.data['entities'] as Entity[];
    expect(entities.map((entity) => entity.id)).toEqual([ENTITY_ID]);

    // Le contrat de la « PR partagée » (spec §7) : le value est un CoverValue.
    const value = CoverValue.parse(entities[0]?.value);
    expect(value.position).toBe(100);
    expect(value.state).toBe('open');
  });

  it('3. send_command MCP descend le volet, et le journal dit que c’est l’agent', async () => {
    const result = await call('send_command', {
      target: ENTITY_ID,
      action: 'set',
      params: { position: 30 },
    });

    expect(result.isError).toBe(false);
    expect(result.data['status']).toBe('ok');

    await vi.waitFor(() => {
      expect(coverState()).toEqual({ position: 30, state: 'stopped' });
    });

    // L'état est retained : un abonné qui arrive après coup retrouve le volet.
    const retained = JSON.parse(await readRetained(`home/state/${DRIVER}/${ENTITY_ID}`)) as Entity;
    expect(retained.kind).toBe('cover');
    expect(CoverValue.parse(retained.value).position).toBe(30);

    const rows = commandRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.issuedBy === 'agent')).toBe(true);
  });

  it('4. le pont HA l’expose et un topic de commande vocale le pilote', async () => {
    const topic = `homeassistant/cover/${haObjectId(ENTITY_ID)}/config`;
    const config = JSON.parse(await readRetained(topic)) as Record<string, unknown>;

    expect(config['unique_id']).toBe(haObjectId(ENTITY_ID));
    expect(config['state_topic']).toBe(`home/state/${DRIVER}/${ENTITY_ID}`);
    expect(config['position_topic']).toBe(`home/state/${DRIVER}/${ENTITY_ID}`);
    expect(config['command_topic']).toBe(haCommandTopic(ENTITY_ID));
    expect(config['set_position_topic']).toBe(haCommandTopic(ENTITY_ID, HA_FIELD.position));

    // Consigne chiffrée (curseur de l'app mobile / intent « ouvre à moitié »).
    await haBus.client.publishAsync(haCommandTopic(ENTITY_ID, HA_FIELD.position), '50', { qos: 1 });
    await vi.waitFor(() => {
      expect(coverState()).toEqual({ position: 50, state: 'stopped' });
    });

    // Verbe (bouton « fermer » de HA) — payload JSON, comme tout ce qui va sous `home/`.
    await haBus.client.publishAsync(haCommandTopic(ENTITY_ID), '"close"', { qos: 1 });
    await vi.waitFor(() => {
      expect(coverState()).toEqual({ position: 0, state: 'closed' });
    });

    const voiceRows = commandRows().filter((row) => row.issuedBy === 'voice');
    expect(voiceRows.length).toBe(2);
  });

  it('5. rien dans apps/core ni apps/agent ne connaît ce driver', async () => {
    const sources = [
      ...(await collectSources(CORE_SRC)),
      ...(await collectSources(join(REPO_ROOT, 'apps', 'agent', 'src'))),
    ];

    // Garde-fou du garde-fou : un chemin cassé rendrait l'assertion vide et vraie.
    expect(sources.length).toBeGreaterThan(10);

    const guilty: string[] = [];
    for (const file of sources) {
      const content = (await readFile(file, 'utf8')).toLowerCase();
      if (content.includes('fake-shutter') || content.includes('fakeshutter')) guilty.push(file);
    }
    expect(guilty).toEqual([]);
  });
});

/**
 * Sources d'un dossier, récursivement, **specs exclues** : un test a le droit de
 * nommer un driver (il monte un scénario de bout en bout), le code non — c'est
 * exactement la frontière posée par `eslint.config.js` (règle `no-driver-names`).
 */
async function collectSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSources(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(path);
    }
  }
  return files;
}
