#!/usr/bin/env node
import process from 'node:process';
import { createLogger } from '@stellar/bus';
import { createApprovalRegistry } from './approvals.js';
import { createEventStream } from './events.js';
import { resolveRepoRoot } from './paths.js';
import { createSetupServer } from './server.js';
import { createSetupSession } from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import { probeStatus } from './status.js';

/**
 * `pnpm setup:ui` — la mise en service **sans installer Claude Code**.
 *
 * Même assistant, même procédure (`.claude/commands/setup.md`, lue à l'exécution),
 * mais servie dans une page locale : l'humain dialogue, et chaque commande ou
 * écriture de fichier passe par une carte d'approbation. C'est le remplacement
 * explicite du système de permissions de Claude Code, pas son contournement — il
 * n'existe aucun mode « tout autoriser » dans ce service, et c'est délibéré
 * (interdit absolu du CLAUDE.md : jamais de bypass, en dev comme en prod).
 *
 * Le process est jetable : une conversation, un onglet, `Ctrl-C` et on recommence.
 */

const SERVICE_NAME = 'setup';
const logger = createLogger(SERVICE_NAME);

const DEFAULT_PORT = 8853;
const DEFAULT_HOST = '127.0.0.1';
const SHUTDOWN_GRACE_MS = 5_000;

function readPort(): number {
  const raw = process.env.SETUP_PORT;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    logger.error(`SETUP_PORT invalide : ${raw} (entier entre 1 et 65535 attendu)`);
    process.exit(1);
  }
  return port;
}

function readOptionalPort(name: string, fallback: number): number {
  const raw = process.env[name];
  const port = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

function requireApiKey(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key !== undefined && key.trim().length > 0) return;
  logger.error(
    'ANTHROPIC_API_KEY absente : l’IHM de setup ne peut pas ouvrir de session. ' +
      'Lance : ANTHROPIC_API_KEY=sk-ant-… pnpm setup:ui  (PowerShell : $env:ANTHROPIC_API_KEY=…). ' +
      'La clé n’est ni écrite ni conservée par ce service — elle ne vit que dans son environnement. ' +
      'Si tu n’as pas de clé, la procédure se suit à la main : TODO_LJ.md.',
  );
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  logger.error('rejet non géré', { error: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('exception non gérée', { error: err.message });
  process.exit(1);
});

requireApiKey();

const repoRoot = resolveRepoRoot();
const port = readPort();

// Le flux d'événements existe avant tout le reste : le registre d'approbations et
// la session ne savent parler qu'à travers lui. Le flux, lui, a besoin de savoir
// ce qui attend une décision quand une IHM (re)connecte — d'où ce `pending`
// paresseux, évalué bien après que le registre existe.
const stream = createEventStream({ pending: () => approvals.pending() });
const approvals = createApprovalRegistry({ emit: stream.emit, logger });

const session = createSetupSession({
  repoRoot,
  systemPrompt: buildSystemPrompt(repoRoot),
  logger,
  emit: stream.emit,
  approvals,
});

const setupServer = createSetupServer({
  logger,
  stream,
  approvals,
  session,
  status: () =>
    probeStatus({
      repoRoot,
      brokerPort: readOptionalPort('STELLAR_MQTT_PORT', 1883),
      coreApiPort: readOptionalPort('CORE_API_PORT', 8850),
    }),
});

try {
  await setupServer.listen(port, DEFAULT_HOST);
} catch (err) {
  // Le cas courant : `pnpm setup:ui` lancé deux fois. Un ECONNRESET brut ne dirait
  // pas quoi faire ; ici la sortie donne la manœuvre.
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    message.includes('EADDRINUSE')
      ? `le port ${port} est déjà pris : une autre IHM de setup tourne sans doute déjà (regarde http://${DEFAULT_HOST}:${port}). ` +
          `Ferme-la, ou choisis un autre port : SETUP_PORT=8854 pnpm setup:ui`
      : `écoute impossible sur ${DEFAULT_HOST}:${port} — ${message}`,
  );
  process.exit(1);
}

logger.info('IHM de setup démarrée', {
  url: `http://${DEFAULT_HOST}:${port}`,
  repoRoot,
  approvals: 'Bash, Write, Edit → carte d’approbation ; Read, Glob, Grep → auto',
});
process.stdout.write(`\n  Ouvre http://${DEFAULT_HOST}:${port} dans un navigateur.\n\n`);

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info('arrêt demandé', { signal });
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  session.close();
  void setupServer.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
