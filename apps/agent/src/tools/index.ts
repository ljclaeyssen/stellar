import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Bus, Logger } from '@stellar/bus';
import type { AgentConfig } from '../config.js';
import {
  createMarketQuoteProvider,
  createMarketQuoteServer,
  MARKET_MCP_SERVER_NAME,
} from './market-quote.js';
import { createProposeRegulationServer, REGULATION_MCP_SERVER_NAME } from './propose-regulation.js';

export * from './market-quote.js';
export * from './propose-regulation.js';

export interface InProcessToolsDeps {
  config: AgentConfig;
  bus: Pick<Bus, 'publishEvent'>;
  logger: Logger;
  clock?: () => Date;
}

/**
 * Les deux tools custom de la spec §11, montés **en process** (le SDK sait servir
 * un serveur MCP en mémoire) : pas de port, pas de sous-process, pas de secret à
 * transporter. Le troisième serveur MCP — celui du core — est distant et branché
 * par `session.ts`, parce qu'il appartient à un autre process.
 */
export function createInProcessMcpServers(
  deps: InProcessToolsDeps,
): Record<string, McpServerConfig> {
  const { config, bus, logger } = deps;
  return {
    [MARKET_MCP_SERVER_NAME]: createMarketQuoteServer(
      createMarketQuoteProvider(config.marketProvider, {
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      }),
    ),
    [REGULATION_MCP_SERVER_NAME]: createProposeRegulationServer({
      regulationConfigPath: config.regulationConfigPath,
      proposalsDir: config.proposalsDir,
      bus,
      logger,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    }),
  };
}
