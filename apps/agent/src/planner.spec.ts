import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
// Cross-import assumé, **de test uniquement** : le planner doit interroger le vrai
// serveur MCP du core, pas un fake. `@stellar/core` n'exporte rien (application, pas
// bibliothèque), d'où le chemin relatif vers sa source — c'est aussi pourquoi
// `tsconfig.json` de ce package ne fixe pas de `rootDir`.
import { createCore, type Core } from '../../core/src/core.js';
import { AgentConfig } from './config.js';
import { connectCoreMcp, type CoreMcpClient } from './core-mcp.js';
import {
  buildMorningPrompt,
  collectMorningContext,
  morningBrief,
  PLANNER_CONTEXT,
} from './planner.js';
import {
  ALLOWED_TOOLS,
  buildTurnOptions,
  CORE_MCP_SERVER_NAME,
  CORE_TOOLS,
  mcpToolName,
  type AgentRuntime,
  type AgentTurnInput,
  type AgentTurnResult,
} from './session.js';

/**
 * PLANNER DU MATIN + INTÉGRATION MCP RÉELLE — **sans modèle**.
 *
 * Le core est monté pour de vrai (broker aedes, miroir, serveur MCP en HTTP
 * streamable) et le planner l'interroge par le même chemin qu'en production. Seul
 * le tour d'agent est faux : `runTurn` capture le prompt au lieu d'appeler Claude.
 *
 * Sur l'« intégration MCP » : le SDK ne sait pas invoquer un tool sans modèle (sa
 * boucle d'outils *est* le modèle). On vérifie donc les deux moitiés qui, réunies,
 * prouvent le branchement : (1) l'URL réellement transmise dans `options.mcpServers`
 * est celle du core démarré, et (2) un client MCP fait un `initialize` et un
 * `tools/list` sur cette même URL — dont les noms correspondent exactement à
 * l'allowlist du SDK. Une divergence de nom de tool, la panne la plus probable de ce
 * branchement, ne peut plus passer.
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PROD_CONFIG = fileURLToPath(new URL('../../../config/regulation.yaml', import.meta.url));
const PERCEPT_DRIVER = 'fakepercepts';

describe('planner du matin', () => {
  let broker: TestBroker;
  let perceptBus: Bus;
  let coreBus: Bus;
  let core: Core;
  let client: CoreMcpClient;

  beforeAll(async () => {
    broker = await startTestBroker();
    perceptBus = await createBus({
      url: broker.url,
      clientId: 'spec-percepts',
      driver: PERCEPT_DRIVER,
      protocolVersion: 4,
      logger,
    });
    coreBus = await createBus({
      url: broker.url,
      clientId: 'spec-core',
      driver: 'core',
      protocolVersion: 4,
      logger,
    });

    core = await createCore({
      bus: coreBus,
      logger,
      journalPath: ':memory:',
      apiPort: null,
      // Ni détection stale ni régulation : le sujet ici est le chemin agent → MCP.
      staleCheckIntervalMs: 3_600_000,
      mcp: { port: 0, host: '127.0.0.1', regulationConfigPath: PROD_CONFIG },
    });

    const ts = '2026-08-04T05:00:00.000Z';
    await perceptBus.publishState({
      id: 'tempo_jour',
      driver: PERCEPT_DRIVER,
      kind: 'tempo',
      value: { couleurJour: 'blanc', couleurDemain: 'rouge', periode: 'HC' },
      ts,
    });
    await perceptBus.publishState({
      id: 'meteo_exterieur',
      driver: PERCEPT_DRIVER,
      kind: 'weather',
      room: 'exterieur',
      value: { pressure: 1013, humidity: 62 },
      ts,
    });
    await perceptBus.publishState({
      id: 'temp_salon',
      driver: PERCEPT_DRIVER,
      kind: 'temperature',
      room: 'salon',
      value: 19.2,
      unit: '°C',
      ts,
    });

    await vi.waitFor(() => {
      expect(core.mirror.getStates()).toHaveLength(3);
    });
    if (core.mcp === null) throw new Error('serveur MCP du core absent');
    client = await connectCoreMcp(core.mcp.url);
  });

  afterAll(async () => {
    await client.close();
    await perceptBus.close();
    await coreBus.close();
    await core.close();
    await broker.close();
  });

  it('relève le contexte du matin par les tools MCP du core', async () => {
    const context = await collectMorningContext(client, new Date('2026-08-04T05:00:00.000Z'));

    expect(context.tempo).toEqual({
      couleurJour: 'blanc',
      couleurDemain: 'rouge',
      periode: 'HC',
    });
    expect(context.percepts.map((entity) => entity.id).sort()).toEqual([
      'meteo_exterieur',
      'temp_salon',
    ]);
    expect(context.regulation?.path).toBe(PROD_CONFIG);
  });

  it('construit un prompt qui porte les couleurs du jour et les consignes', async () => {
    const context = await collectMorningContext(client, new Date('2026-08-04T05:00:00.000Z'));
    const prompt = buildMorningPrompt(context);

    // Les couleurs : celle d'aujourd'hui et celle de demain (c'est elle qui déclenche
    // la préchauffe nocturne, spec §10).
    expect(prompt).toContain('aujourd’hui blanc');
    expect(prompt).toContain('demain rouge');
    expect(prompt).toContain('période en cours HC');

    // Les consignes du jour, lues dans la vraie configuration de régulation.
    expect(prompt).toContain('Consignes de chauffage en vigueur');
    expect(prompt).toContain('salon : present 20.5 °C');
    expect(prompt).toContain('chambre :');

    // Les percepts déjà relevés, pour que l'agent n'ait pas à les redemander.
    expect(prompt).toContain('temp_salon');
    expect(prompt).toContain('19.2');
    expect(prompt).toContain('4 août 2026');
  });

  it('lance un tour d’agent avec le contexte « prise de parole »', async () => {
    const seen: AgentTurnInput[] = [];
    const runtime: AgentRuntime = {
      runTurn: (input) => {
        seen.push(input);
        return Promise.resolve({
          text: 'Journée blanche, demain rouge.',
          isError: false,
          usage: { durationMs: 1, toolCalls: 0, modelTurns: 1 },
          daily: {
            date: '2026-08-04',
            turns: 1,
            errors: 0,
            durationMs: 1,
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            updatedAt: '2026-08-04T05:00:00.000Z',
          },
        } satisfies AgentTurnResult);
      },
    };

    const result = await morningBrief({
      client,
      runtime,
      now: new Date('2026-08-04T05:00:00.000Z'),
    });

    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context).toBe(PLANNER_CONTEXT);
    expect(seen[0]?.prompt).toContain('demain rouge');
  });

  it('branche l’agent sur le serveur MCP réellement démarré', async () => {
    if (core.mcp === null) throw new Error('serveur MCP du core absent');
    const config = AgentConfig.parse({ coreMcpUrl: core.mcp.url, usageDir: 'data' });
    const options = buildTurnOptions(
      { config, logger },
      { prompt: 'peu importe' },
      new AbortController(),
    );

    const coreServer = (options.mcpServers ?? {})[CORE_MCP_SERVER_NAME];
    expect(coreServer).toMatchObject({ type: 'http', url: core.mcp.url });

    // Le même URL, parlé pour de vrai : initialize + tools/list.
    const raw = new Client({ name: 'spec-allowlist', version: '0.0.0' });
    await raw.connect(new StreamableHTTPClientTransport(new URL(core.mcp.url)));
    try {
      const served = (await raw.listTools()).tools.map((tool) => tool.name).sort();
      expect(served).toEqual([...CORE_TOOLS].sort());
      // Chaque tool servi est nommément autorisé côté SDK : aucune dérive possible
      // entre le core et l'allowlist de l'agent.
      for (const name of served) {
        expect(ALLOWED_TOOLS).toContain(mcpToolName(CORE_MCP_SERVER_NAME, name));
      }
    } finally {
      await raw.close();
    }
  });

  it('lit un état du core à travers le client MCP, comme le fera l’agent', async () => {
    const states = await client.getStates({ room: 'salon' });
    expect(states.map((entity) => entity.id)).toContain('temp_salon');
    // Sélecteur `kind` + `room` uniquement : aucun nom de driver ne circule (règle n°7).
    const outside = await client.getStates({ room: 'inexistante' });
    expect(outside).toEqual([]);
  });
});
