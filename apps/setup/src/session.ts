import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@stellar/bus';
import type { ApprovalRegistry } from './approvals.js';
import type { SetupEvent } from './events.js';
import { redactText, redactValue, truncate } from './redaction.js';

/**
 * La session de l'IHM de setup : **une conversation, un process, pas de reprise**.
 *
 * Choix structurant — *streaming input*. Le `query()` du SDK est appelé UNE fois,
 * avec un `AsyncIterable<SDKUserMessage>` alimenté au fil des messages de
 * l'humain. Conséquences, toutes voulues :
 * - la conversation garde son contexte de bout en bout (l'appairage de la TV se
 *   souvient de l'IP donnée dix minutes plus tôt) sans qu'on rejoue d'historique
 *   ni qu'on dépende de `resume` et du stockage de sessions du SDK ;
 * - `canUseTool` fonctionne : c'est le rappel de permission du SDK, et c'est lui
 *   qui donne son sens à l'IHM (chaque Bash/Write/Edit devient une carte) ;
 * - la session meurt avec le process. Une IHM de première mise en service n'a pas
 *   à survivre à son onglet : on relance `pnpm setup:ui` et on repart.
 *
 * L'alternative (une requête par tour + `resume`) a été écartée : elle relance un
 * sous-process à chaque message, perd le contexte vivant, et fait dépendre le
 * premier setup d'un répertoire de sessions persistées — exactement ce que la
 * spec refuse pour l'agent de production (§11).
 *
 * La **couture de test** est `queryFn`, comme dans `apps/agent` (ADR-010) : les
 * suites injectent un faux flux SDK et vérifient les garde-fous sans clé d'API ni
 * un seul token dépensé.
 */

/** Signature minimale du `query()` du SDK — tout ce dont ce module a besoin. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Lecture seule : approuvés sans déranger l'humain, simplement tracés.
 *
 * NB : le SDK peut décider lui-même qu'un tool de lecture n'a pas à demander, et
 * ne pas appeler `canUseTool` du tout. L'issue est la même (autorisé) ; seule la
 * ligne de trace dans le fil peut manquer. On ne s'appuie donc JAMAIS sur cette
 * liste pour interdire — elle n'autorise que ce qui est déjà inoffensif.
 */
export const AUTO_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** Effet de bord : exécution ou écriture. **Toujours** une carte d'approbation. */
export const APPROVAL_TOOLS = ['Bash', 'Write', 'Edit'] as const;

/**
 * Le socle d'outils chargé. Rien d'autre n'existe pour cette session : ni Task
 * (qui ferait tourner un sous-agent hors du champ des approbations), ni WebFetch,
 * ni les tools MCP du core — le core n'est pas encore censé tourner.
 */
export const SETUP_TOOLS: readonly string[] = [...AUTO_TOOLS, ...APPROVAL_TOOLS];

/** Ce qui part vers le navigateur reste lisible : ni un dump, ni un fichier entier. */
const MAX_DETAIL_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 160;

export interface SetupSessionDeps {
  repoRoot: string;
  systemPrompt: string;
  logger: Logger;
  emit: (event: SetupEvent) => void;
  approvals: ApprovalRegistry;
  /** Défaut : le `query()` du SDK. Injecté en test. */
  queryFn?: QueryFn;
  model?: string;
}

export interface SetupSession {
  /** Pousse un tour humain. Démarre la session SDK au premier appel. */
  send(text: string): void;
  /** Un tour est en cours (l'IHM grise sa zone de saisie). */
  busy(): boolean;
  /** Ferme le flux d'entrée et abandonne le tour en cours. */
  close(): void;
}

// ───────────────────────── file d'attente des tours humains ─────────────────────────

interface UserMessageQueue {
  iterable: AsyncIterable<SDKUserMessage>;
  push(text: string): void;
  close(): void;
}

/**
 * File asynchrone à un seul consommateur (le SDK). Un `push` avant que le SDK ne
 * demande le message suivant est mis en tampon ; un `next()` en avance attend.
 */
function createUserMessageQueue(): UserMessageQueue {
  const buffered: SDKUserMessage[] = [];
  const waiting: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  let closed = false;

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: (): AsyncIterator<SDKUserMessage> => ({
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = buffered.shift();
        if (next !== undefined) return Promise.resolve({ value: next, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };

  return {
    iterable,
    push(text) {
      if (closed) return;
      const message: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      };
      const resolve = waiting.shift();
      if (resolve === undefined) buffered.push(message);
      else resolve({ value: message, done: false });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
    },
  };
}

// ───────────────────────── lecture des demandes d'outil ─────────────────────────

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Titre de carte : une seule ligne, coupée court — le détail est juste en dessous. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_SUMMARY_CHARS)}…`;
};

/**
 * Traduit une demande d'outil en carte lisible. C'est le texte sur lequel
 * l'humain décide : il doit montrer la commande exacte, le fichier exact, le
 * remplacement exact — pas un résumé du modèle, qui pourrait mentir.
 */
export function describeToolUse(
  tool: string,
  input: Record<string, unknown>,
): { summary: string; detail: string } {
  const path = asString(input['file_path']);

  if (tool === 'Bash') {
    const command = asString(input['command']) ?? '';
    const description = asString(input['description']);
    return {
      summary: oneLine(redactText(command)),
      detail: redactText(
        truncate(
          description === undefined ? command : `# ${description}\n${command}`,
          MAX_DETAIL_CHARS,
        ),
      ),
    };
  }

  if (tool === 'Write' && path !== undefined) {
    const content = asString(input['content']) ?? '';
    return {
      summary: `écrire ${path} (${content.length} caractères)`,
      detail: redactText(truncate(content, MAX_DETAIL_CHARS)),
    };
  }

  if (tool === 'Edit' && path !== undefined) {
    const before = asString(input['old_string']) ?? '';
    const after = asString(input['new_string']) ?? '';
    const all = input['replace_all'] === true ? ' (toutes les occurrences)' : '';
    return {
      summary: `modifier ${path}${all}`,
      detail: redactText(
        `--- avant\n${truncate(before, MAX_DETAIL_CHARS / 2)}\n\n+++ après\n${truncate(after, MAX_DETAIL_CHARS / 2)}`,
      ),
    };
  }

  // Tool inconnu de ce module (ou entrée inattendue) : on montre l'entrée brute
  // masquée plutôt que de résumer — l'humain décide sur pièce, pas sur confiance.
  return {
    summary: oneLine(tool),
    detail: truncate(redactValue(input), MAX_DETAIL_CHARS),
  };
}

// ───────────────────────────────── la session ─────────────────────────────────

/**
 * Options SDK de la session. Extrait pour être inspectable en test : c'est **le**
 * point où les garde-fous sont décidés.
 */
export function buildSessionOptions(
  deps: SetupSessionDeps,
  abortController: AbortController,
  canUseTool: NonNullable<Options['canUseTool']>,
): Options {
  return {
    abortController,
    systemPrompt: deps.systemPrompt,
    // Socle réduit : six outils, pas un de plus (cf. SETUP_TOOLS).
    tools: [...SETUP_TOOLS],
    // `allowedTools` reste VIDE à dessein : tout ce qui y figurerait serait
    // auto-approuvé *sans passer par `canUseTool`*, donc sans carte. Le seul
    // point de décision est le rappel ci-dessous.
    allowedTools: [],
    // `default` = « demande » : c'est ce qui fait appeler `canUseTool`. Jamais
    // `bypassPermissions`, jamais `acceptEdits` — ce serait supprimer l'IHM.
    permissionMode: 'default',
    canUseTool,
    // Le setup travaille dans le dépôt : installer, remplir `.env`, appairer.
    cwd: deps.repoRoot,
    // Isolation vis-à-vis du poste : ni CLAUDE.md, ni settings, ni MCP hérités.
    // Le prompt système est `.claude/commands/setup.md` et rien d'autre.
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    ...(deps.model !== undefined ? { model: deps.model } : {}),
  };
}

export function createSetupSession(deps: SetupSessionDeps): SetupSession {
  const queryFn = deps.queryFn ?? query;
  const queue = createUserMessageQueue();
  const abortController = new AbortController();
  let started = false;
  let turnActive = false;

  const canUseTool: NonNullable<Options['canUseTool']> = async (
    toolName,
    input,
    options,
  ): Promise<PermissionResult> => {
    const described = describeToolUse(toolName, input);

    if ((AUTO_TOOLS as readonly string[]).includes(toolName)) {
      deps.logger.info('outil auto-approuvé', { tool: toolName, summary: described.summary });
      deps.emit({ type: 'tool', tool: toolName, summary: described.summary });
      return { behavior: 'allow', updatedInput: input };
    }

    const decision = await deps.approvals.request(
      { tool: toolName, summary: described.summary, detail: described.detail },
      options.signal,
    );
    if (decision.allow) {
      // Trace d'exécution : la console qui a lancé l'IHM garde ce qui a tourné.
      deps.logger.info('outil approuvé par l’humain', {
        tool: toolName,
        summary: described.summary,
      });
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message:
        decision.reason === 'timeout'
          ? 'Refusé : l’humain n’a pas répondu à temps dans l’interface. Repropose l’action ou demande-lui ce qui coince.'
          : 'Refusé par l’humain dans l’interface. N’exécute pas cette action et demande-lui comment procéder.',
    };
  };

  const handle = (message: SDKMessage): void => {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'text') continue;
        const text = redactText(block.text).trim();
        if (text.length > 0) deps.emit({ type: 'assistant', text });
      }
      return;
    }
    if (message.type === 'result') {
      turnActive = false;
      const isError = message.subtype !== 'success';
      deps.emit({
        type: 'turn-end',
        isError,
        ...(isError ? { errorReason: message.subtype } : {}),
      });
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const options = buildSessionOptions(deps, abortController, canUseTool);
    void (async (): Promise<void> => {
      try {
        for await (const message of queryFn({ prompt: queue.iterable, options })) {
          handle(message);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.logger.error('session de setup interrompue', { error: reason });
        deps.emit({ type: 'error', message: redactText(reason) });
      } finally {
        // Le flux est mort : plus personne ne consommera la file, et une carte
        // en attente n'a plus de destinataire. Rendre la main, fermé.
        turnActive = false;
        queue.close();
        deps.approvals.denyAll('session-closed');
        deps.emit({ type: 'turn-end', isError: false });
      }
    })();
  };

  return {
    send(text) {
      deps.emit({ type: 'user', text: redactText(text) });
      turnActive = true;
      start();
      queue.push(text);
    },
    busy: () => turnActive,
    close() {
      queue.close();
      abortController.abort();
      deps.approvals.denyAll('shutdown');
    },
  };
}
