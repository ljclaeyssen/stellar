#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import process from 'node:process';
import { z } from 'zod';
import { createBus, createLogger, type Bus } from '@stellar/bus';
import { applyProposal, createReadlineConfirm } from './apply-proposal.js';
import { loadConfig, type AgentConfig } from './config.js';
import { connectCoreMcp } from './core-mcp.js';
import { morningBrief } from './planner.js';
import { createAgentRuntime, type AgentRuntime, type AgentTurnResult } from './session.js';
import { createInProcessMcpServers } from './tools/index.js';

/**
 * Service agent (spec §11).
 *
 * Trois commandes, un seul assemblage :
 * - `run` (défaut) : prise HTTP en loopback — `POST /turn` est la future « conversation
 *   agent » de Home Assistant (P8), `POST /planner/run` déclenche le brief du matin ;
 * - `planner` : un seul brief puis sortie — c'est ce que lance le timer systemd de 7 h
 *   (gabarits dans `apps/agent/systemd/`) ;
 * - `apply` : application humaine d'une proposition de régulation.
 *
 * `ANTHROPIC_API_KEY` n'est exigée que par les deux commandes qui parlent au modèle.
 * `apply` s'en passe — et les tests aussi, par construction (aucun appel réel).
 */

const SERVICE_NAME = 'agent';
const logger = createLogger(SERVICE_NAME);

const SHUTDOWN_GRACE_MS = 5_000;
/** Un prompt de conversation vocale ne fait pas 64 Kio. */
const MAX_BODY_BYTES = 65_536;

const TurnRequest = z
  .object({
    prompt: z.string().min(1, 'prompt vide').max(8_000),
    context: z.string().max(4_000).optional(),
  })
  .strict();

function requireApiKey(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key !== undefined && key.length > 0) return;
  logger.error(
    'ANTHROPIC_API_KEY absente : le service agent ne peut pas ouvrir de session. ' +
      'La clé se stocke chiffrée (sops/age) et s’injecte par l’environnement du service — voir TODO_LJ.md §P7. ' +
      'La commande « apply » fonctionne sans clé.',
  );
  process.exit(1);
}

function buildRuntime(config: AgentConfig, bus: Bus): AgentRuntime {
  return createAgentRuntime({
    config,
    logger,
    sdkMcpServers: createInProcessMcpServers({ config, bus, logger }),
  });
}

// ─────────────────────────────── prise HTTP ───────────────────────────────

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

/** Réponse HTTP d'un tour : ce que la voix (P8) consommera. */
function turnPayload(result: AgentTurnResult): Record<string, unknown> {
  return {
    text: result.text,
    isError: result.isError,
    ...(result.errorReason !== undefined ? { errorReason: result.errorReason } : {}),
    usage: result.usage,
    daily: result.daily,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  };
}

async function runService(config: AgentConfig): Promise<void> {
  requireApiKey();

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${SERVICE_NAME}-service`,
    driver: SERVICE_NAME,
  });
  const runtime = buildRuntime(config, bus);

  // Plafond de tours simultanés : un tour coûte des tokens, et rien ne limite un
  // client qui bégaie. Le budget de la spec §11 commence par ne pas être dépassé.
  let inFlight = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST' || (path !== '/turn' && path !== '/planner/run')) {
      sendJson(res, 404, { error: 'inconnu — POST /turn ou POST /planner/run' });
      return;
    }
    if (inFlight >= config.maxConcurrentTurns) {
      sendJson(res, 429, { error: 'trop de tours simultanés' });
      return;
    }

    inFlight++;
    try {
      if (path === '/turn') {
        const body = TurnRequest.safeParse(await readJsonBody(req));
        if (!body.success) {
          sendJson(res, 400, { error: 'requête invalide', issues: body.error.issues });
          return;
        }
        sendJson(res, 200, turnPayload(await runtime.runTurn(body.data)));
        return;
      }

      const client = await connectCoreMcp(config.coreMcpUrl);
      try {
        sendJson(res, 200, turnPayload(await morningBrief({ client, runtime })));
      } finally {
        await client.close();
      }
    } finally {
      inFlight--;
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error('requête en échec', { error: String(err) });
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: 'erreur interne' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info('agent démarré', {
    url: `http://${config.host}:${config.port}`,
    coreMcpUrl: config.coreMcpUrl,
    turnTimeoutMs: config.turnTimeoutMs,
    marketProvider: config.marketProvider,
    proposalsDir: config.proposalsDir,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.closeAllConnections();
    void (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await bus.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ────────────────────────────── commandes ponctuelles ──────────────────────────────

async function runPlannerOnce(config: AgentConfig): Promise<void> {
  requireApiKey();
  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${SERVICE_NAME}-planner`,
    driver: SERVICE_NAME,
  });
  const client = await connectCoreMcp(config.coreMcpUrl);
  try {
    const result = await morningBrief({ client, runtime: buildRuntime(config, bus) });
    logger.info('brief du matin', { text: result.text, isError: result.isError });
    process.stdout.write(`${result.text}\n`);
  } finally {
    await client.close();
    await bus.close();
  }
}

async function runApply(config: AgentConfig, argv: string[]): Promise<void> {
  const proposalPath = argv.find((arg) => !arg.startsWith('--'));
  if (proposalPath === undefined) {
    logger.error('usage : stellar-agent apply <fichier de proposition> [--yes]');
    process.exit(1);
  }
  const yes = argv.includes('--yes');
  const outcome = await applyProposal({
    proposalPath,
    regulationConfigPath: config.regulationConfigPath,
    yes,
    ...(yes ? {} : { confirm: createReadlineConfirm() }),
  });
  process.exit(outcome === 'applied' ? 0 : 1);
}

// Un bug non rattrapé ne doit pas laisser un process à moitié vivant : on sort en
// erreur, la supervision (systemd) relance.
process.on('unhandledRejection', (reason) => {
  logger.error('rejet non géré', { error: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('exception non gérée', { error: err.message });
  process.exit(1);
});

const command = process.argv[2] ?? 'run';
const config = loadConfig();

if (command === 'run') {
  await runService(config);
} else if (command === 'planner') {
  await runPlannerOnce(config);
} else if (command === 'apply') {
  await runApply(config, process.argv.slice(3));
} else {
  logger.error(`commande inconnue : ${command} (attendu : run | planner | apply)`);
  process.exit(1);
}
