import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import { ProposalError, writeProposal } from '../proposals.js';

/**
 * `propose_regulation_change` (spec §11) — le tool le plus important à lire de travers.
 *
 * Il **n'écrit jamais** `config/regulation.yaml`. Il dépose une proposition dans
 * `config/proposals/` et publie un événement sur le bus ; l'application est un geste
 * humain (`stellar-agent apply`). Deux raisons, dans cet ordre :
 *
 * 1. Ce fichier pilote le chauffage et le délestage sans supervision. Une erreur de
 *    consigne ne se voit pas tout de suite et se paye en confort ou en facture.
 * 2. La spec §11 l'exige : « toute écriture persistante = confirmation ».
 *
 * L'agent n'a par ailleurs **aucun outil d'écriture de fichier** dans son allowlist
 * (cf. `session.ts`) : ce tool est le seul chemin par lequel il peut proposer une
 * modification, et ce chemin s'arrête sur un humain.
 */

/** Nom du serveur MCP in-process — préfixe des tools côté SDK. */
export const REGULATION_MCP_SERVER_NAME = 'regulation';
export const PROPOSE_REGULATION_TOOL = 'propose_regulation_change';

/**
 * Émetteur des événements de l'agent sur le bus. Ce n'est pas un nom de driver
 * (règle n°7) : c'est la provenance, la même que `issuedBy: 'agent'` des commandes.
 */
export const AGENT_EVENT_SOURCE = 'agent';
export const REGULATION_PROPOSAL_EVENT = 'regulation_proposal';

export interface ProposeRegulationDeps {
  /** Fichier de référence du diff — lu, jamais écrit. */
  regulationConfigPath: string;
  proposalsDir: string;
  /** Le bus n'est utilisé qu'en publication d'événement. */
  bus: Pick<Bus, 'publishEvent'>;
  logger: Logger;
  clock?: () => Date;
}

export function createProposeRegulationServer(
  deps: ProposeRegulationDeps,
): McpSdkServerConfigWithInstance {
  const clock = deps.clock ?? ((): Date => new Date());

  return createSdkMcpServer({
    name: REGULATION_MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      tool(
        PROPOSE_REGULATION_TOOL,
        'Dépose une proposition de modification des paramètres de régulation. N’applique RIEN : le fichier de production reste inchangé tant qu’un humain n’a pas relu et validé la proposition. Fournir le contenu COMPLET du fichier proposé (pas un fragment) — lire d’abord la configuration actuelle.',
        {
          summary: z
            .string()
            .min(1)
            .describe('une phrase : ce que change la proposition et pourquoi'),
          proposedYaml: z
            .string()
            .min(1)
            .describe('contenu complet du fichier de régulation proposé, en YAML'),
        },
        (args) => {
          try {
            const { path, proposal } = writeProposal({
              regulationConfigPath: deps.regulationConfigPath,
              proposalsDir: deps.proposalsDir,
              summary: args.summary,
              proposedYaml: args.proposedYaml,
              now: clock(),
            });

            // L'événement est ce qui permettra à la voix (P8) ou à une UI d'annoncer
            // « une proposition attend ta relecture » sans interroger le disque.
            void deps.bus
              .publishEvent({
                driver: AGENT_EVENT_SOURCE,
                type: REGULATION_PROPOSAL_EVENT,
                data: { path, summary: proposal.summary, createdAt: proposal.createdAt },
                ts: proposal.createdAt,
              })
              .catch((err: unknown) => {
                // Le fichier est écrit : l'événement raté est une gêne, pas une perte.
                deps.logger.warn('publication de la proposition sur le bus en échec', {
                  path,
                  error: String(err),
                });
              });

            deps.logger.info('proposition de régulation déposée', {
              path,
              summary: proposal.summary,
            });

            const payload = {
              status: 'proposed',
              path,
              summary: proposal.summary,
              createdAt: proposal.createdAt,
              diff: proposal.diff,
              applied: false,
              note: `Proposition déposée dans ${path}. Le fichier de régulation n’a PAS été modifié : un humain doit la relire et l’appliquer (stellar-agent apply). Dis-le clairement.`,
            };
            return Promise.resolve({
              content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
              structuredContent: payload,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err instanceof ProposalError ? err.code : 'proposal_failure';
            deps.logger.warn('proposition de régulation refusée', { error: message, code });
            return Promise.resolve({
              content: [{ type: 'text' as const, text: message }],
              structuredContent: { error: message, code, applied: false },
              isError: true,
            });
          }
        },
      ),
    ],
  });
}
