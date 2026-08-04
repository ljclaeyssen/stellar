import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerConfig, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@stellar/bus';
import { AgentConfig } from './config.js';
import {
  ALLOWED_TOOLS,
  buildTurnOptions,
  CORE_MCP_SERVER_NAME,
  DISALLOWED_TOOLS,
  runAgentTurn,
  type AgentDeps,
  type QueryFn,
} from './session.js';
import { usageFilePath } from './usage.js';

/**
 * SESSIONS ÉPHÉMÈRES — **aucun appel de modèle**, jamais, dans cette suite.
 *
 * La couture est `queryFn` : on injecte un faux flux SDK (messages assistant +
 * `result` avec `usage`) et on vérifie tout ce qui, en production, protège la
 * maison et le portefeuille — l'allowlist stricte, les serveurs MCP passés, le
 * prompt vocal, le timeout par tour, et le budget journalisé et cumulé.
 *
 * Un test qui exigerait une clé d'API ne serait pas un test : ce serait une
 * dépense (ADR-010).
 */

interface LoggedLine {
  msg: string;
  extra?: Record<string, unknown>;
}

function recordingLogger(lines: LoggedLine[]): Logger {
  const push =
    () =>
    (msg: string, extra?: Record<string, unknown>): void => {
      lines.push(extra === undefined ? { msg } : { msg, extra });
    };
  return { debug: push(), info: push(), warn: push(), error: push() };
}

/** Les messages du SDK portent beaucoup de champs ; les tests n'en peuplent que le nécessaire. */
function assistantMessage(text: string, toolUses = 0): SDKMessage {
  const content = [
    { type: 'text', text },
    ...Array.from({ length: toolUses }, (_unused, index) => ({
      type: 'tool_use',
      id: `tool_${index}`,
      name: 'mcp__core__get_state',
      input: {},
    })),
  ];
  return {
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content },
    parent_tool_use_id: null,
    uuid: '11111111-1111-4111-8111-111111111111',
    session_id: 'session-test',
  } as unknown as SDKMessage;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1_234,
    duration_api_ms: 1_000,
    is_error: false,
    num_turns: 2,
    result: 'Il fait dix-neuf degrés au salon. Tu veux que je monte la consigne ?',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 1_500,
      output_tokens: 120,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '22222222-2222-4222-8222-222222222222',
    session_id: 'session-test',
    ...overrides,
  } as unknown as SDKMessage;
}

/** Faux `query()` : rejoue un flux et capture les options reçues. */
function fakeQuery(messages: SDKMessage[]): { queryFn: QueryFn; captured: () => Options } {
  let seen: Options | undefined;
  const queryFn: QueryFn = (params) => {
    seen = params.options;
    return (async function* () {
      for (const message of messages) {
        await Promise.resolve();
        yield message;
      }
    })();
  };
  return {
    queryFn,
    captured: () => {
      if (seen === undefined) throw new Error('queryFn n’a pas été appelé');
      return seen;
    },
  };
}

const FAKE_SDK_SERVERS: Record<string, McpServerConfig> = {
  market: { type: 'sdk', name: 'market' } as McpServerConfig,
  regulation: { type: 'sdk', name: 'regulation' } as McpServerConfig,
};

describe('tour d’agent (session éphémère)', () => {
  let usageDir: string;
  let lines: LoggedLine[];
  let config: AgentConfig;

  const depsWith = (queryFn: QueryFn): AgentDeps => ({
    config,
    logger: recordingLogger(lines),
    sdkMcpServers: FAKE_SDK_SERVERS,
    queryFn,
    clock: () => new Date('2026-08-04T06:30:00.000Z'),
  });

  beforeEach(() => {
    usageDir = mkdtempSync(join(tmpdir(), 'stellar-agent-usage-'));
    lines = [];
    config = AgentConfig.parse({
      coreMcpUrl: 'http://127.0.0.1:18851/mcp',
      usageDir,
      turnTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    rmSync(usageDir, { recursive: true, force: true });
  });

  it('transmet l’allowlist stricte, les serveurs MCP et le prompt vocal', async () => {
    const { queryFn, captured } = fakeQuery([assistantMessage('Bonjour.'), resultMessage()]);
    await runAgentTurn({ prompt: 'Il fait quel temps ?' }, depsWith(queryFn));
    const options = captured();

    // L'allowlist, à la lettre : web + MCP du core + les deux tools custom.
    expect(options.allowedTools).toEqual([...ALLOWED_TOOLS]);
    expect(options.allowedTools).toContain('mcp__core__get_state');
    expect(options.allowedTools).toContain('mcp__market__market_quote');
    expect(options.allowedTools).toContain('mcp__regulation__propose_regulation_change');

    // Le socle d'outils intégrés se limite au web : aucun outil de fichier ni de shell.
    expect(options.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.disallowedTools).toEqual([...DISALLOWED_TOOLS]);

    // Isolation : ni CLAUDE.md, ni .mcp.json, ni session persistée.
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.maxTurns).toBe(config.maxTurns);

    const servers = options.mcpServers ?? {};
    expect(servers[CORE_MCP_SERVER_NAME]).toMatchObject({
      type: 'http',
      url: config.coreMcpUrl,
    });
    expect(Object.keys(servers).sort()).toEqual(['core', 'market', 'regulation']);

    const systemPrompt = options.systemPrompt;
    // Une chaîne, pas le preset « claude_code » : ce service n'est pas Claude Code.
    if (typeof systemPrompt !== 'string') throw new Error('prompt système attendu en chaîne');
    expect(systemPrompt).toContain('Stellar Home');
    expect(systemPrompt).toContain('2 à 3 phrases');
    expect(systemPrompt).toContain('notification');
    expect(systemPrompt).toContain('français');
    // Le garde-fou sécurité est rappelé au modèle, en plus d'être appliqué côté core.
    expect(systemPrompt).toContain('serrures');
  });

  it('n’expose aucun outil d’écriture de fichier ni d’exécution de commande', () => {
    const forbidden = ['Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit', 'Task'];
    for (const tool of forbidden) expect(ALLOWED_TOOLS).not.toContain(tool);
    // Le seul chemin d'écriture est le tool de proposition — qui n'écrit pas non plus
    // la configuration de production (cf. proposals.spec.ts).
    expect(ALLOWED_TOOLS.filter((name) => name.includes('propose'))).toEqual([
      'mcp__regulation__propose_regulation_change',
    ]);
  });

  it('injecte le contexte situationnel en fin de prompt système', async () => {
    const { queryFn, captured } = fakeQuery([resultMessage()]);
    await runAgentTurn(
      { prompt: 'Brief.', context: 'Déclenché au réveil, personne ne t’a parlé.' },
      depsWith(queryFn),
    );
    const systemPrompt = captured().systemPrompt;
    if (typeof systemPrompt !== 'string') throw new Error('prompt système attendu en chaîne');
    expect(systemPrompt).toContain('Déclenché au réveil');
  });

  it('journalise le budget du tour et cumule la journée sur disque', async () => {
    const deps = depsWith(fakeQuery([assistantMessage('Voilà.', 3), resultMessage()]).queryFn);
    const first = await runAgentTurn({ prompt: 'Pourquoi la clim a tourné ?' }, deps);

    expect(first.isError).toBe(false);
    expect(first.text).toContain('dix-neuf degrés');
    expect(first.usage.tokensIn).toBe(1_500);
    expect(first.usage.tokensOut).toBe(120);
    expect(first.usage.cacheReadTokens).toBe(800);
    expect(first.usage.costUsd).toBeCloseTo(0.0123, 6);
    expect(first.usage.toolCalls).toBe(3);
    expect(first.usage.modelTurns).toBe(2);
    expect(first.daily.turns).toBe(1);

    const budget = lines.find((line) => line.msg.includes('tour d’agent terminé'));
    expect(budget?.extra).toMatchObject({
      toolCalls: 3,
      tokensIn: 1_500,
      tokensOut: 120,
      dailyTurns: 1,
      dailyCostUsd: 0.0123,
    });
    expect(typeof budget?.extra?.durationMs).toBe('number');

    // Deuxième tour : le cumul du jour s'ajoute au lieu d'écraser.
    const second = await runAgentTurn({ prompt: 'Et demain ?' }, deps);
    expect(second.daily.turns).toBe(2);
    expect(second.daily.tokensIn).toBe(3_000);
    expect(second.daily.toolCalls).toBe(6);
    expect(second.daily.costUsd).toBeCloseTo(0.0246, 6);

    const path = usageFilePath(usageDir, new Date('2026-08-04T06:30:00.000Z'));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ date: '2026-08-04', turns: 2, tokensIn: 3_000, errors: 0 });
  });

  it('interrompt un tour qui dépasse son budget de temps', async () => {
    config = AgentConfig.parse({ usageDir, turnTimeoutMs: 60 });
    const queryFn: QueryFn = () =>
      (async function* () {
        // Un flux qui ne rend jamais la main : c'est exactement ce contre quoi le
        // timeout existe (transport bloqué, modèle qui boucle).
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30_000).unref();
        });
        yield resultMessage();
      })();

    const deps: AgentDeps = {
      config,
      logger: recordingLogger(lines),
      queryFn,
      clock: () => new Date('2026-08-04T06:30:00.000Z'),
    };

    const started = Date.now();
    const result = await runAgentTurn({ prompt: 'Raconte-moi ta vie.' }, deps);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.isError).toBe(true);
    expect(result.errorReason).toBe('timeout');
    // La voix doit pouvoir dire quelque chose, même sur un échec.
    expect(result.text.length).toBeGreaterThan(0);
    // Le tour raté compte quand même au budget du jour.
    expect(result.daily.turns).toBe(1);
    expect(result.daily.errors).toBe(1);
  });

  it('signale un échec du SDK sans masquer le résultat', async () => {
    const { queryFn } = fakeQuery([
      assistantMessage('Je cherche…'),
      resultMessage({ subtype: 'error_max_turns', is_error: true, result: undefined }),
    ]);
    const result = await runAgentTurn({ prompt: 'Boucle.' }, depsWith(queryFn));
    expect(result.isError).toBe(true);
    expect(result.errorReason).toBe('error_max_turns');
    expect(result.text).toContain('Je cherche');
  });

  it('déclenche l’AbortController du SDK au timeout', async () => {
    config = AgentConfig.parse({ usageDir, turnTimeoutMs: 40 });
    let controller: AbortController | undefined;
    const queryFn: QueryFn = (params) => {
      controller = params.options?.abortController;
      return (async function* () {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30_000).unref();
        });
        yield resultMessage();
      })();
    };
    await runAgentTurn(
      { prompt: 'Bloque.' },
      { config, logger: recordingLogger(lines), queryFn, clock: () => new Date() },
    );
    expect(controller?.signal.aborted).toBe(true);
  });

  it('buildTurnOptions est pur : mêmes entrées, mêmes garde-fous', () => {
    const controller = new AbortController();
    const options = buildTurnOptions(
      { config, logger: recordingLogger(lines) },
      { prompt: 'x' },
      controller,
    );
    expect(options.abortController).toBe(controller);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([CORE_MCP_SERVER_NAME]);
  });
});
