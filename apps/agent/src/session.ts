import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpServerConfig,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@stellar/bus';
import type { AgentConfig } from './config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { MARKET_MCP_SERVER_NAME, MARKET_QUOTE_TOOL } from './tools/market-quote.js';
import { PROPOSE_REGULATION_TOOL, REGULATION_MCP_SERVER_NAME } from './tools/propose-regulation.js';
import { recordUsage, type DailyUsage, type TurnUsage } from './usage.js';

/**
 * Un tour d'agent = **une session éphémère** du Claude Agent SDK (spec §11).
 *
 * Aucune session immortelle : chaque appel construit ses options, consomme le flux
 * de messages jusqu'au `result`, journalise son budget, et meurt. Le contexte ne
 * gonfle pas, une dérive ne survit pas au tour, et un plantage n'emporte que lui.
 *
 * La **couture de test** est `queryFn` : par défaut le `query()` du SDK, qui parle
 * au modèle ; en test un faux flux. C'est ce qui permet de vérifier les garde-fous
 * (allowlist, MCP, timeout, budget) sans jamais dépenser un token ni exiger une clé
 * d'API (ADR-010).
 */

/** Signature minimale du `query()` du SDK — tout ce dont ce module a besoin. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/** Nom sous lequel le serveur MCP du core est monté (préfixe `mcp__core__…`). */
export const CORE_MCP_SERVER_NAME = 'core';

/** Les tools du serveur MCP du core (apps/core/src/mcp/server.ts). */
export const CORE_TOOLS = [
  'get_state',
  'send_command',
  'subscribe',
  'poll_subscription',
  'list_capabilities',
  'query_journal',
  'get_regulation_config',
] as const;

/** Tools intégrés au SDK que l'agent a le droit d'utiliser (spec §11). */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/**
 * **L'allowlist stricte.** Rien d'autre n'existe pour l'agent.
 *
 * Défense en profondeur, trois couches indépendantes :
 * 1. `tools` ne contient que les deux tools web → aucun tool intégré d'écriture de
 *    fichier ni d'exécution de commande n'est même chargé ;
 * 2. `allowedTools` liste nommément ce qui est auto-approuvé, et `permissionMode:
 *    'dontAsk'` refuse tout le reste sans jamais bloquer sur une question (le
 *    service est sans interface) ;
 * 3. `disallowedTools` re-nomme les tools dangereux, au cas où une version future du
 *    SDK élargirait le socle par défaut.
 *
 * Le refus des `kind` de sécurité, lui, n'est pas ici : il est **côté serveur MCP du
 * core**, donc inatteignable même si cette liste dérivait (spec §11).
 */
export const ALLOWED_TOOLS: readonly string[] = [
  ...WEB_TOOLS,
  ...CORE_TOOLS.map((tool) => mcpToolName(CORE_MCP_SERVER_NAME, tool)),
  mcpToolName(MARKET_MCP_SERVER_NAME, MARKET_QUOTE_TOOL),
  mcpToolName(REGULATION_MCP_SERVER_NAME, PROPOSE_REGULATION_TOOL),
];

/** Filet nominal : ces tools ne doivent jamais être atteignables depuis l'agent. */
export const DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Task',
  'TodoWrite',
];

/** Timeout d'un appel de tool MCP — borné bien en deçà du timeout du tour. */
const MCP_TOOL_TIMEOUT_MS = 30_000;

export interface AgentTurnInput {
  prompt: string;
  /** Situationnel injecté en fin de prompt système (voix, planner). */
  context?: string;
}

export interface AgentTurnResult {
  /** Réponse à dire à voix haute. Jamais vide : un échec produit une phrase parlable. */
  text: string;
  isError: boolean;
  /** Code court d'échec (`timeout`, `sdk_error`…) — absent si le tour a abouti. */
  errorReason?: string;
  usage: TurnUsage;
  /** Cumul du jour après ce tour. */
  daily: DailyUsage;
  sessionId?: string;
}

export interface AgentDeps {
  config: AgentConfig;
  logger: Logger;
  /** Serveurs MCP in-process (market_quote, propose_regulation_change). */
  sdkMcpServers?: Record<string, McpServerConfig>;
  /** Défaut : le `query()` du SDK. Injecté en test. */
  queryFn?: QueryFn;
  clock?: () => Date;
}

/** Phrase rendue quand le tour n'aboutit pas — l'enceinte doit dire quelque chose. */
const TIMEOUT_TEXT =
  'Je n’ai pas réussi à répondre dans le temps imparti. Tu veux que je réessaie ?';
const FAILURE_TEXT = 'Je n’ai pas réussi à traiter la demande. Tu veux réessayer ?';

export class AgentTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`tour d’agent interrompu après ${timeoutMs} ms`);
    this.name = 'AgentTurnTimeoutError';
  }
}

/**
 * Construit les options SDK d'un tour. Extrait de `runAgentTurn` pour être
 * inspectable en test : c'est **le** point où les garde-fous sont décidés.
 */
export function buildTurnOptions(
  deps: AgentDeps,
  input: AgentTurnInput,
  abortController: AbortController,
): Options {
  const { config } = deps;
  const mcpServers: Record<string, McpServerConfig> = {
    [CORE_MCP_SERVER_NAME]: {
      type: 'http',
      url: config.coreMcpUrl,
      timeout: MCP_TOOL_TIMEOUT_MS,
    },
    ...(deps.sdkMcpServers ?? {}),
  };

  return {
    abortController,
    systemPrompt: buildSystemPrompt(input.context),
    // Socle d'outils intégrés réduit aux deux tools web (cf. ALLOWED_TOOLS).
    tools: [...WEB_TOOLS],
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    // Service sans interface : ne jamais demander, refuser ce qui n'est pas approuvé.
    permissionMode: 'dontAsk',
    mcpServers,
    // Ignore .mcp.json, les settings du dépôt et tout MCP hérité : l'agent de
    // production ne doit voir que les serveurs listés ci-dessus.
    strictMcpConfig: true,
    // Isolation totale vis-à-vis du poste de dev : ni CLAUDE.md, ni settings, ni
    // skills du dépôt. Ce service n'est pas Claude Code (principe n°9).
    settingSources: [],
    // Sessions éphémères : rien n'est écrit dans ~/.claude/projects.
    persistSession: false,
    maxTurns: config.maxTurns,
    cwd: process.cwd(),
    ...(config.model !== undefined ? { model: config.model } : {}),
  };
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pick(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

/** Le SDK n'expose pas toujours tous les compteurs : chaque champ est facultatif. */
function readUsage(usage: unknown): Omit<TurnUsage, 'durationMs' | 'toolCalls' | 'modelTurns'> {
  const tokensIn = toNumber(pick(usage, 'input_tokens'));
  const tokensOut = toNumber(pick(usage, 'output_tokens'));
  const cacheRead = toNumber(pick(usage, 'cache_read_input_tokens'));
  const cacheCreation = toNumber(pick(usage, 'cache_creation_input_tokens'));
  return {
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
  };
}

interface Collected {
  texts: string[];
  toolCalls: number;
  sessionId?: string;
  result?: SDKMessage & { type: 'result' };
}

function collect(message: SDKMessage, into: Collected): void {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') into.texts.push(block.text);
      else if (block.type === 'tool_use' || block.type === 'server_tool_use') into.toolCalls++;
    }
    into.sessionId = message.session_id;
    return;
  }
  if (message.type === 'result') {
    into.result = message;
    into.sessionId = message.session_id;
  }
}

/**
 * Joue un tour complet.
 *
 * Le timeout est une course, pas seulement un `abort()` : un transport qui ne rend
 * jamais la main ne doit pas laisser la prise HTTP (et l'humain qui parle) en
 * attente indéfinie. L'`AbortController` est quand même déclenché pour que le SDK
 * libère son sous-process.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  deps: AgentDeps,
): Promise<AgentTurnResult> {
  const { config, logger } = deps;
  const clock = deps.clock ?? ((): Date => new Date());
  const queryFn = deps.queryFn ?? query;
  const startedAt = Date.now();

  const abortController = new AbortController();
  const options = buildTurnOptions(deps, input, abortController);
  const collected: Collected = { texts: [], toolCalls: 0 };

  const consume = async (): Promise<void> => {
    for await (const message of queryFn({ prompt: input.prompt, options })) {
      collect(message, collected);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new AgentTurnTimeoutError(config.turnTimeoutMs));
    }, config.turnTimeoutMs);
  });

  let failure: Error | undefined;
  try {
    const consumed = consume();
    // Le flux abandonné peut rejeter après la course : sans ce filet, un timeout
    // deviendrait un `unhandledRejection` qui tue le service.
    consumed.catch(() => undefined);
    await Promise.race([consumed, expired]);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const result = collected.result;
  const costUsd = toNumber(pick(result, 'total_cost_usd'));
  const usage: TurnUsage = {
    durationMs: Date.now() - startedAt,
    toolCalls: collected.toolCalls,
    modelTurns: toNumber(pick(result, 'num_turns')) ?? 0,
    ...readUsage(pick(result, 'usage')),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };

  const timedOut = failure instanceof AgentTurnTimeoutError;
  const sdkError = result !== undefined && result.subtype !== 'success';
  const isError = failure !== undefined || sdkError || result === undefined;

  const text = ((): string => {
    if (result?.subtype === 'success' && result.result.trim().length > 0) return result.result;
    const gathered = collected.texts.join('\n').trim();
    if (gathered.length > 0) return gathered;
    return timedOut ? TIMEOUT_TEXT : FAILURE_TEXT;
  })();

  const errorReason = ((): string | undefined => {
    if (timedOut) return 'timeout';
    if (failure !== undefined) return 'sdk_error';
    if (result === undefined) return 'no_result';
    if (result.subtype !== 'success') return result.subtype;
    return undefined;
  })();

  const daily = recordUsage({ dir: config.usageDir, usage, isError, now: clock() });

  // Le budget de la spec §11 : une ligne par tour, et le cumul du jour avec.
  logger.info('tour d’agent terminé', {
    ...usage,
    isError,
    ...(errorReason !== undefined ? { errorReason } : {}),
    ...(collected.sessionId !== undefined ? { sessionId: collected.sessionId } : {}),
    promptChars: input.prompt.length,
    dailyTurns: daily.turns,
    dailyTokensIn: daily.tokensIn,
    dailyTokensOut: daily.tokensOut,
    dailyCostUsd: daily.costUsd,
    dailyToolCalls: daily.toolCalls,
  });
  if (failure !== undefined) {
    logger.error('tour d’agent en échec', { error: failure.message, reason: errorReason });
  }

  return {
    text,
    isError,
    ...(errorReason !== undefined ? { errorReason } : {}),
    usage,
    daily,
    ...(collected.sessionId !== undefined ? { sessionId: collected.sessionId } : {}),
  };
}

export interface AgentRuntime {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

/** Fige les dépendances d'un service : `main.ts` et le planner ne portent qu'un `runTurn`. */
export function createAgentRuntime(deps: AgentDeps): AgentRuntime {
  return { runTurn: (input) => runAgentTurn(input, deps) };
}
