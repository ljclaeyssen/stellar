import { describe, expect, it, vi } from 'vitest';
import { createApprovalRegistry } from './approvals.js';
import type { SetupEvent } from './events.js';
import {
  APPROVAL_TOOLS,
  AUTO_TOOLS,
  buildSessionOptions,
  createSetupSession,
  describeToolUse,
  SETUP_TOOLS,
} from './session.js';
import { createFakeSdk, silentLogger } from './testing.js';

/**
 * La session de setup — **aucun appel de modèle** dans cette suite (ADR-010).
 *
 * On vérifie ici ce qui, en production, protège la machine : le socle d'outils
 * réduit, l'absence d'auto-approbation, le mode de permission qui *demande*, et
 * le fait qu'aucun secret ne franchisse le flux vers le navigateur.
 */

function harness(options: Parameters<typeof createFakeSdk>[0] = {}): {
  session: ReturnType<typeof createSetupSession>;
  events: SetupEvent[];
  fake: ReturnType<typeof createFakeSdk>;
} {
  const { logger } = silentLogger();
  const events: SetupEvent[] = [];
  const emit = (event: SetupEvent): void => {
    events.push(event);
  };
  const approvals = createApprovalRegistry({ emit, logger, timeoutMs: 40 });
  const fake = createFakeSdk(options);
  const session = createSetupSession({
    repoRoot: '/repo',
    systemPrompt: 'prompt de test',
    logger,
    emit,
    approvals,
    queryFn: fake.queryFn,
  });
  return { session, events, fake };
}

describe('garde-fous des options SDK', () => {
  const { logger } = silentLogger();
  const events: SetupEvent[] = [];
  const approvals = createApprovalRegistry({
    emit: (event) => events.push(event),
    logger,
  });
  const options = buildSessionOptions(
    {
      repoRoot: '/repo',
      systemPrompt: 'prompt de test',
      logger,
      emit: () => undefined,
      approvals,
    },
    new AbortController(),
    () => Promise.resolve({ behavior: 'deny', message: 'non' }),
  );

  it('ne charge que les six outils du setup', () => {
    expect(options.tools).toEqual([...SETUP_TOOLS]);
    expect(SETUP_TOOLS).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit']);
    // Ni sous-agents (Task) ni web : le champ de l'approbation doit rester fermé.
    expect(options.tools).not.toContain('Task');
    expect(options.tools).not.toContain('WebFetch');
  });

  it('n’auto-approuve rien : tout passe par canUseTool', () => {
    // Un tool listé dans `allowedTools` ne déclencherait PAS `canUseTool`, donc
    // pas de carte. Cette liste doit rester vide, c'est la garantie de l'IHM.
    expect(options.allowedTools).toEqual([]);
    expect(options.canUseTool).toBeTypeOf('function');
  });

  it('ne bascule jamais en mode bypass', () => {
    expect(options.permissionMode).toBe('default');
    expect(options.permissionMode).not.toBe('bypassPermissions');
    expect(options.permissionMode).not.toBe('acceptEdits');
  });

  it('travaille dans le dépôt, isolé des réglages de la machine', () => {
    expect(options.cwd).toBe('/repo');
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(options.systemPrompt).toBe('prompt de test');
  });

  it('partitionne lecture seule et effets de bord', () => {
    expect([...AUTO_TOOLS]).toEqual(['Read', 'Glob', 'Grep']);
    expect([...APPROVAL_TOOLS]).toEqual(['Bash', 'Write', 'Edit']);
    for (const tool of AUTO_TOOLS) {
      expect(APPROVAL_TOOLS as readonly string[]).not.toContain(tool);
    }
  });
});

describe('description d’une demande d’outil', () => {
  it('montre la commande exacte pour Bash', () => {
    const { summary, detail } = describeToolUse('Bash', {
      command: 'docker compose -f infra/docker-compose.yml up -d',
      description: 'démarre mosquitto',
    });
    expect(summary).toContain('docker compose');
    expect(detail).toContain('# démarre mosquitto');
    expect(detail).toContain('up -d');
  });

  it('montre le fichier et le contenu pour Write, masqués', () => {
    const { summary, detail } = describeToolUse('Write', {
      file_path: 'config/hue-app-key.json',
      content: '{"appKey":"tres-secret"}',
    });
    expect(summary).toContain('config/hue-app-key.json');
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain('tres-secret');
  });

  it('montre un avant/après pour Edit', () => {
    const { summary, detail } = describeToolUse('Edit', {
      file_path: '.env',
      old_string: 'ATV_HOST=',
      new_string: 'ATV_HOST=192.168.1.42',
      replace_all: true,
    });
    expect(summary).toBe('modifier .env (toutes les occurrences)');
    expect(detail).toContain('--- avant');
    expect(detail).toContain('+++ après');
    expect(detail).toContain('192.168.1.42');
  });

  it('montre l’entrée brute masquée pour un outil inattendu', () => {
    const { detail } = describeToolUse('Inconnu', { token: 'zzz', host: '10.0.0.1' });
    expect(detail).toContain('10.0.0.1');
    expect(detail).not.toContain('zzz');
  });
});

describe('flux d’une session', () => {
  it('masque les secrets d’un message assistant avant de l’émettre', async () => {
    const { session, events } = harness({
      reply: "j’ai lu le fichier : {token:'abc123'} — je continue ?",
    });
    session.send('vas-y');

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'assistant')).toBe(true);
    });
    const assistant = events.find((event) => event.type === 'assistant');
    expect(assistant?.text).toContain('[REDACTED]');
    expect(assistant?.text).not.toContain('abc123');
    session.close();
  });

  it('émet le tour humain puis la fin de tour', async () => {
    const { session, events } = harness({ reply: 'bien reçu' });
    session.send('bonjour');
    expect(events[0]).toMatchObject({ type: 'user', text: 'bonjour' });
    expect(session.busy()).toBe(true);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'turn-end')).toBe(true);
    });
    expect(session.busy()).toBe(false);
    session.close();
  });

  it('garde le contexte d’un tour à l’autre : un seul appel au SDK', async () => {
    const { session, fake } = harness({ reply: 'ok' });
    session.send('première question');
    await vi.waitFor(() => {
      expect(fake.prompts).toHaveLength(1);
    });
    session.send('deuxième question');
    await vi.waitFor(() => {
      expect(fake.prompts).toHaveLength(2);
    });
    // Streaming input : la même conversation reçoit les deux tours.
    expect(fake.prompts[0]).toContain('première question');
    expect(fake.prompts[1]).toContain('deuxième question');
    session.close();
  });

  it('refuse les approbations restées en attente à la fermeture', async () => {
    const { session, events } = harness({
      toolUses: [{ tool: 'Bash', input: { command: 'sudo reboot' } }],
    });
    session.send('redémarre');

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'approval')).toBe(true);
    });
    session.close();

    await vi.waitFor(() => {
      const resolved = events.find((event) => event.type === 'approval-resolved');
      expect(resolved).toMatchObject({ allow: false });
    });
  });
});
