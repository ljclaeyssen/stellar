import { request as httpRequest } from 'node:http';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@stellar/bus';
import type { SetupEvent } from './events.js';
import type { QueryFn } from './session.js';

/**
 * Outillage des suites de `apps/setup` — **aucun appel de modèle, aucune clé**.
 *
 * La couture est la même que dans `apps/agent` (ADR-010) : `queryFn`. On injecte
 * un faux flux SDK qui appelle `canUseTool` exactement comme le vrai, ce qui rend
 * vérifiable la seule chose qui compte vraiment ici — qu'une commande ne s'exécute
 * jamais sans un clic humain.
 *
 * Ce module est exclu de l'émission (`tsconfig.build.json`) : il ne part pas dans
 * `dist/`.
 */

export function silentLogger(lines: { msg: string; extra?: Record<string, unknown> }[] = []): {
  logger: Logger;
  lines: { msg: string; extra?: Record<string, unknown> }[];
} {
  const push =
    () =>
    (msg: string, extra?: Record<string, unknown>): void => {
      lines.push(extra === undefined ? { msg } : { msg, extra });
    };
  return { logger: { debug: push(), info: push(), warn: push(), error: push() }, lines };
}

/** Message assistant minimal — les suites ne peuplent que ce qu'elles observent. */
export function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: '11111111-1111-4111-8111-111111111111',
    session_id: 'session-test',
  } as unknown as SDKMessage;
}

export function resultMessage(subtype = 'success'): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 12,
    is_error: subtype !== 'success',
    num_turns: 1,
    result: 'fini',
    session_id: 'session-test',
  } as unknown as SDKMessage;
}

/** Une demande d'outil scriptée : ce que le faux modèle « veut » faire. */
export interface ScriptedToolUse {
  tool: string;
  input: Record<string, unknown>;
}

export interface FakeSdk {
  queryFn: QueryFn;
  /** Décisions rendues par `canUseTool`, dans l'ordre — ce que le modèle a vu. */
  decisions: { tool: string; behavior: string; message?: string }[];
  /** Tours humains reçus par le faux flux. */
  prompts: string[];
  /** Options passées au `query()` — pour inspecter les garde-fous. */
  options?: Options;
}

/**
 * Faux SDK en *streaming input* : il consomme la file de messages humains, et
 * pour chaque tour joue les demandes d'outil scriptées avant de répondre.
 */
export function createFakeSdk(script: {
  toolUses?: ScriptedToolUse[];
  reply?: string;
  subtype?: string;
}): FakeSdk {
  const fake: FakeSdk = {
    queryFn: () => [] as unknown as AsyncIterable<SDKMessage>,
    decisions: [],
    prompts: [],
  };

  fake.queryFn = ({ prompt, options }): AsyncIterable<SDKMessage> => {
    fake.options = options;
    return (async function* (): AsyncGenerator<SDKMessage> {
      if (typeof prompt === 'string') throw new Error('streaming input attendu');
      for await (const message of prompt) {
        const content = message.message.content;
        fake.prompts.push(typeof content === 'string' ? content : JSON.stringify(content));

        for (const [index, use] of (script.toolUses ?? []).entries()) {
          const decision = await options?.canUseTool?.(use.tool, use.input, {
            signal: options.abortController?.signal ?? new AbortController().signal,
            toolUseID: `tool_${index}`,
            requestId: `req_${index}`,
          });
          fake.decisions.push({
            tool: use.tool,
            behavior: decision?.behavior ?? 'none',
            ...(decision?.behavior === 'deny' ? { message: decision.message } : {}),
          });
        }

        yield assistantMessage(script.reply ?? 'ok');
        yield resultMessage(script.subtype ?? 'success');
      }
    })();
  };

  return fake;
}

// ─────────────────────────────── lecture du flux SSE ───────────────────────────────

export interface SseCollector {
  /** Les événements décodés, dans l'ordre d'arrivée. */
  events: SetupEvent[];
  stop: () => void;
}

/**
 * Branche un vrai client SSE sur `/events` et accumule les événements décodés.
 * Les suites vérifient ainsi ce que le navigateur reçoit réellement — trames
 * comprises — et pas une abstraction interne.
 */
export function collectSse(url: string): Promise<SseCollector> {
  return new Promise<SseCollector>((resolve, reject) => {
    const events: SetupEvent[] = [];
    let buffer = '';

    const req = httpRequest(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const data = buffer
            .slice(0, cut)
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          buffer = buffer.slice(cut + 2);
          if (data.length > 0) events.push(JSON.parse(data) as SetupEvent);
          cut = buffer.indexOf('\n\n');
        }
      });
      // Flux coupé en fin de test : il n'y a rien à signaler.
      res.on('error', () => undefined);
      resolve({
        events,
        stop: () => {
          res.destroy();
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}
