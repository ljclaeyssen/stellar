import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { parse as parseYaml } from 'yaml';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import type { BusEvent } from '@stellar/contracts';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { Proposal } from '../proposals.js';
import {
  createFakeMarketQuoteProvider,
  createMarketQuoteServer,
  MARKET_QUOTE_TOOL,
} from './market-quote.js';
import {
  createProposeRegulationServer,
  PROPOSE_REGULATION_TOOL,
  REGULATION_PROPOSAL_EVENT,
} from './propose-regulation.js';

/**
 * LES DEUX TOOLS CUSTOM (spec §11), appelés **à travers un vrai client MCP**.
 *
 * Les serveurs in-process du SDK sont des serveurs MCP ordinaires : on les branche
 * sur un transport en mémoire et on les interroge comme le ferait le modèle. Tester
 * la fonction du handler à la main laisserait passer une erreur de schéma d'entrée
 * ou de nom de tool — exactement ce qui casse en production.
 *
 * L'enjeu du second tool tient en une assertion : `config/regulation.yaml`
 * **n'est pas modifié**.
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Le vrai fichier de production, copié dans un bac à sable pour chaque suite. */
const PROD_CONFIG = fileURLToPath(new URL('../../../../config/regulation.yaml', import.meta.url));

interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

async function connectSdkServer(server: McpSdkServerConfigWithInstance): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolOutcome>;
  listTools: () => Promise<string[]>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec', version: '0.0.0' });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('');
      return { isError: result.isError === true, text, data: result.structuredContent ?? {} };
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    },
    async close() {
      await client.close();
      await server.instance.close();
    },
  };
}

describe('market_quote', () => {
  it('rend un prix stable par symbole, horodaté, et annoncé comme factice', async () => {
    const provider = createFakeMarketQuoteProvider({
      clock: () => new Date('2026-08-04T09:00:00.000Z'),
    });
    const first = await provider.quote('aapl');
    const second = await provider.quote('AAPL ');
    const other = await provider.quote('MC.PA');

    // Déterminisme : la casse et les espaces ne changent rien, le symbole si.
    expect(first).toEqual(second);
    expect(first.symbol).toBe('AAPL');
    expect(first.price).toBe(second.price);
    expect(first.price).not.toBe(other.price);
    expect(first.price).toBeGreaterThan(0);
    expect(first.currency).toBe('EUR');
    expect(first.ts).toBe('2026-08-04T09:00:00.000Z');
    expect(first.fake).toBe(true);
  });

  it('expose le tool au modèle avec la mention « données factices »', async () => {
    const server = createMarketQuoteServer(createFakeMarketQuoteProvider());
    const mcp = await connectSdkServer(server);
    try {
      expect(await mcp.listTools()).toEqual([MARKET_QUOTE_TOOL]);

      const outcome = await mcp.call(MARKET_QUOTE_TOOL, { symbol: 'AAPL' });
      expect(outcome.isError).toBe(false);
      expect(outcome.data).toMatchObject({ symbol: 'AAPL', currency: 'EUR', fake: true });
      expect(String(outcome.data.notice)).toContain('DONNÉES FACTICES');
      expect(typeof outcome.data.price).toBe('number');

      // Entrée hors schéma : refusée par MCP, pas par le handler.
      const bad = await mcp.call(MARKET_QUOTE_TOOL, { symbol: '' });
      expect(bad.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});

describe('propose_regulation_change', () => {
  let broker: TestBroker;
  let bus: Bus;
  let watcher: Bus;
  let sandbox: string;
  let configPath: string;
  let proposalsDir: string;
  const events: BusEvent[] = [];

  beforeAll(async () => {
    broker = await startTestBroker();
    bus = await createBus({
      url: broker.url,
      clientId: 'spec-agent',
      driver: 'agent',
      protocolVersion: 4,
      logger,
    });
    watcher = await createBus({
      url: broker.url,
      clientId: 'spec-watcher',
      driver: 'spec-watcher',
      protocolVersion: 4,
      logger,
    });
    // `onEvent` préfixe déjà `home/event/` (packages/bus).
    await watcher.onEvent('#', (event) => events.push(event));

    sandbox = mkdtempSync(join(tmpdir(), 'stellar-agent-proposals-'));
    configPath = join(sandbox, 'regulation.yaml');
    proposalsDir = join(sandbox, 'proposals');
    mkdirSync(proposalsDir, { recursive: true });
    // La vraie configuration de production : le diff porte sur du réel.
    copyFileSync(PROD_CONFIG, configPath);
  });

  afterAll(async () => {
    await watcher.close();
    await bus.close();
    await broker.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  const server = (): McpSdkServerConfigWithInstance =>
    createProposeRegulationServer({
      regulationConfigPath: configPath,
      proposalsDir,
      bus,
      logger,
      clock: () => new Date('2026-08-04T09:15:30.500Z'),
    });

  it('dépose une proposition, publie l’événement, et NE TOUCHE PAS au fichier de production', async () => {
    const before = readFileSync(configPath, 'utf8');
    const proposed = before.replace('present: 20.5', 'present: 21');
    expect(proposed).not.toBe(before);

    const mcp = await connectSdkServer(server());
    try {
      expect(await mcp.listTools()).toEqual([PROPOSE_REGULATION_TOOL]);

      const outcome = await mcp.call(PROPOSE_REGULATION_TOOL, {
        summary: 'Monter la consigne « présent » du salon à 21 °C',
        proposedYaml: proposed,
      });

      expect(outcome.isError).toBe(false);
      expect(outcome.data).toMatchObject({ status: 'proposed', applied: false });
      expect(String(outcome.data.note)).toContain('n’a PAS été modifié');

      // 1. Le fichier de production est intact — l'invariant de la phase.
      expect(readFileSync(configPath, 'utf8')).toBe(before);

      // 2. Un fichier de proposition valide, nommé et parsable.
      const files = readdirSync(proposalsDir);
      expect(files).toHaveLength(1);
      const name = files[0] ?? '';
      expect(name).toMatch(/^2026-08-04T09-15-30-500Z-.*\.yaml$/);
      expect(name).toContain('monter-la-consigne');

      const parsed = Proposal.parse(parseYaml(readFileSync(join(proposalsDir, name), 'utf8')));
      expect(parsed.summary).toContain('21 °C');
      expect(parsed.createdAt).toBe('2026-08-04T09:15:30.500Z');
      expect(parsed.proposedYaml).toBe(proposed);
      expect(parsed.diff).toContain('-    setpoints: { present: 20.5');
      expect(parsed.diff).toContain('+    setpoints: { present: 21');
      expect(parsed.diff.startsWith('--- ')).toBe(true);

      // 3. L'événement bus, pour que la voix puisse annoncer la proposition (P8).
      await expect.poll(() => events.length).toBeGreaterThan(0);
      const event = events.find((item) => item.type === REGULATION_PROPOSAL_EVENT);
      expect(event?.driver).toBe('agent');
      expect(event?.data).toMatchObject({ summary: parsed.summary });
    } finally {
      await mcp.close();
    }
  });

  it('refuse un yaml illisible, un fragment, ou une proposition sans changement', async () => {
    const before = readFileSync(configPath, 'utf8');
    const mcp = await connectSdkServer(server());
    try {
      const broken = await mcp.call(PROPOSE_REGULATION_TOOL, {
        summary: 'yaml cassé',
        proposedYaml: 'rooms: [\n  salon: {',
      });
      expect(broken.isError).toBe(true);
      expect(broken.data.code).toBe('invalid_yaml');

      const fragment = await mcp.call(PROPOSE_REGULATION_TOOL, {
        summary: 'fragment',
        proposedYaml: '- juste une liste',
      });
      expect(fragment.isError).toBe(true);
      expect(fragment.data.code).toBe('invalid_yaml_shape');

      const identical = await mcp.call(PROPOSE_REGULATION_TOOL, {
        summary: 'aucun changement',
        proposedYaml: before,
      });
      expect(identical.isError).toBe(true);
      expect(identical.data.code).toBe('empty_diff');

      expect(readFileSync(configPath, 'utf8')).toBe(before);
    } finally {
      await mcp.close();
    }
  });
});
