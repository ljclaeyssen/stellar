import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalRegistry } from './approvals.js';
import { createEventStream, type SetupEvent } from './events.js';
import { createSetupServer, type SetupServer } from './server.js';
import { createSetupSession } from './session.js';
import { collectSse, createFakeSdk, silentLogger, type FakeSdk } from './testing.js';

/**
 * **Le cœur du sujet** : rien de sensible ne s'exécute sans un clic humain.
 *
 * Ces cas montent l'IHM entière — serveur HTTP, flux SSE réel (lu et décodé
 * comme le ferait le navigateur), registre d'approbations, session — avec un faux
 * SDK à la place du modèle. Le faux SDK appelle `canUseTool` exactement comme le
 * vrai, et **observe la décision rendue** : c'est cette valeur de retour qui, en
 * production, autorise ou non l'exécution.
 *
 * Trois chemins, tous vérifiés du bout du doigt jusqu'au SDK : refus explicite,
 * autorisation explicite, silence (délai expiré → refus).
 */

let running: SetupServer | undefined;

interface Booted {
  base: string;
  sse: Awaited<ReturnType<typeof collectSse>>;
  fake: FakeSdk;
}

async function boot(options: {
  toolUses?: { tool: string; input: Record<string, unknown> }[];
  reply?: string;
  timeoutMs?: number;
}): Promise<Booted> {
  const { logger } = silentLogger();
  const fake = createFakeSdk({
    ...(options.toolUses !== undefined ? { toolUses: options.toolUses } : {}),
    ...(options.reply !== undefined ? { reply: options.reply } : {}),
  });

  const stream = createEventStream({ pending: () => approvals.pending() });
  const approvals = createApprovalRegistry({
    emit: stream.emit,
    logger,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const session = createSetupSession({
    repoRoot: process.cwd(),
    systemPrompt: 'prompt de test',
    logger,
    emit: stream.emit,
    approvals,
    queryFn: fake.queryFn,
  });
  const server = createSetupServer({
    logger,
    stream,
    approvals,
    session,
    status: () =>
      Promise.resolve({
        broker: false,
        coreApi: false,
        env: false,
        ports: { broker: 1883, coreApi: 8850 },
      }),
  });

  const port = await server.listen(0, '127.0.0.1');
  running = server;
  const base = `http://127.0.0.1:${port}`;
  return { base, sse: await collectSse(`${base}/events`), fake };
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Attend qu'une carte d'approbation soit parvenue au « navigateur ». */
async function waitForApproval(
  sse: Awaited<ReturnType<typeof collectSse>>,
): Promise<Extract<SetupEvent, { type: 'approval' }>> {
  return vi.waitFor(() => {
    const event = sse.events.find(
      (candidate): candidate is Extract<SetupEvent, { type: 'approval' }> =>
        candidate.type === 'approval',
    );
    if (event === undefined) throw new Error('aucune demande d’approbation reçue');
    return event;
  });
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('approbation d’un outil sensible', () => {
  it('publie une demande sur /events et refuse quand l’humain refuse', async () => {
    const { base, sse, fake } = await boot({
      toolUses: [{ tool: 'Bash', input: { command: 'rm -rf config/' } }],
    });

    await post(base, '/message', { text: 'installe tout' });
    const approval = await waitForApproval(sse);

    expect(approval.tool).toBe('Bash');
    expect(approval.summary).toContain('rm -rf config/');
    expect(approval.requestId).toBeTruthy();
    // Tant que personne n'a cliqué, le SDK n'a rien reçu : rien n'a tourné.
    expect(fake.decisions).toEqual([]);

    const res = await post(base, '/approve', { requestId: approval.requestId, allow: false });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(fake.decisions).toHaveLength(1);
    });
    expect(fake.decisions[0]?.behavior).toBe('deny');
    expect(fake.decisions[0]?.message).toContain('Refusé');

    await vi.waitFor(() => {
      const resolved = sse.events.find((event) => event.type === 'approval-resolved');
      expect(resolved).toMatchObject({ allow: false, reason: 'human' });
    });
    sse.stop();
  });

  it('autorise quand l’humain autorise', async () => {
    const { base, sse, fake } = await boot({
      toolUses: [{ tool: 'Write', input: { file_path: '.env', content: 'ATV_HOST=192.168.1.42' } }],
    });

    await post(base, '/message', { text: 'crée le .env' });
    const approval = await waitForApproval(sse);
    expect(approval.tool).toBe('Write');
    expect(approval.summary).toContain('.env');

    await post(base, '/approve', { requestId: approval.requestId, allow: true });

    await vi.waitFor(() => {
      expect(fake.decisions).toEqual([{ tool: 'Write', behavior: 'allow' }]);
    });
    sse.stop();
  });

  it('refuse tout seul quand le délai expire (fail-closed)', async () => {
    const { base, sse, fake } = await boot({
      toolUses: [{ tool: 'Bash', input: { command: 'pnpm install' } }],
      timeoutMs: 40,
    });

    await post(base, '/message', { text: 'installe les dépendances' });

    await vi.waitFor(() => {
      expect(fake.decisions).toHaveLength(1);
    });
    expect(fake.decisions[0]).toMatchObject({ tool: 'Bash', behavior: 'deny' });
    expect(fake.decisions[0]?.message).toContain('pas répondu à temps');

    await vi.waitFor(() => {
      const resolved = sse.events.find((event) => event.type === 'approval-resolved');
      expect(resolved).toMatchObject({ allow: false, reason: 'timeout' });
    });
    sse.stop();
  });

  it('n’interroge pas l’humain pour un outil de lecture seule', async () => {
    const { base, sse, fake } = await boot({
      toolUses: [{ tool: 'Read', input: { file_path: 'docs/SPEC.md' } }],
    });

    await post(base, '/message', { text: 'lis la spec' });

    await vi.waitFor(() => {
      expect(fake.decisions).toEqual([{ tool: 'Read', behavior: 'allow' }]);
    });
    // La trace parvient bien à l'IHM — mais sans jamais rien lui demander.
    await vi.waitFor(() => {
      expect(sse.events.some((event) => event.type === 'tool')).toBe(true);
    });
    expect(sse.events.some((event) => event.type === 'approval')).toBe(false);
    sse.stop();
  });

  it('ne tranche une demande qu’une seule fois', async () => {
    const { base, sse } = await boot({
      toolUses: [{ tool: 'Bash', input: { command: 'docker compose up -d' } }],
    });

    await post(base, '/message', { text: 'lance le broker' });
    const approval = await waitForApproval(sse);

    const first = await post(base, '/approve', { requestId: approval.requestId, allow: false });
    const second = await post(base, '/approve', { requestId: approval.requestId, allow: true });

    expect(first.status).toBe(200);
    // Le second clic (double-clic, second onglet) ne peut pas ré-autoriser.
    expect(second.status).toBe(409);
    sse.stop();
  });
});

describe('flux SSE', () => {
  it('redonne les demandes en attente à une IHM qui se reconnecte', async () => {
    const { base, sse } = await boot({
      toolUses: [{ tool: 'Bash', input: { command: 'age-keygen -o key.txt' } }],
    });

    await post(base, '/message', { text: 'initialise sops' });
    const approval = await waitForApproval(sse);
    sse.stop();

    // Rechargement de la page : la carte en cours ne doit pas disparaître.
    const reconnected = await collectSse(`${base}/events`);
    const hello = await vi.waitFor(() => {
      const event = reconnected.events.find(
        (candidate): candidate is Extract<SetupEvent, { type: 'hello' }> =>
          candidate.type === 'hello',
      );
      if (event === undefined) throw new Error('pas de hello');
      return event;
    });

    expect(hello.pending).toHaveLength(1);
    expect(hello.pending[0]?.requestId).toBe(approval.requestId);
    reconnected.stop();
  });
});
