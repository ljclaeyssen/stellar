import { z } from 'zod';

/**
 * Configuration du service agent (spec §11), par variables d'environnement.
 *
 * Deux points méritent l'attention :
 *
 * - `ANTHROPIC_API_KEY` **n'est pas** dans ce schéma. Elle n'est requise que par
 *   le service qui tourne pour de vrai (`main.ts` la vérifie au démarrage) : les
 *   tests, eux, ne doivent jamais pouvoir appeler un modèle, donc la config doit
 *   se charger sans clé. C'est la couture de la stratégie de test (ADR-010).
 * - Aucun chemin n'est absolu par défaut : comme `apps/core`, le service se lance
 *   depuis la racine du dépôt (systemd `WorkingDirectory=`).
 */

const positiveMs = (fallback: number) =>
  z.coerce.number().int().positive('durée en ms strictement positive attendue').default(fallback);

const port = (fallback: number) =>
  z.coerce.number().int().min(0).max(65_535, 'port hors bornes').default(fallback);

/**
 * Fournisseur de cours de bourse (`market_quote`).
 *
 * `fake` est le **seul** implémenté : le vrai fournisseur est une décision humaine
 * ouverte (TODO_LJ.md §P7). L'enum existe pour que le jour où le choix est fait, la
 * bascule tienne en une variable d'environnement et une implémentation de
 * `MarketQuoteProvider` — pas en une réécriture du tool.
 */
export const MarketProvider = z.enum(['fake']);
export type MarketProvider = z.infer<typeof MarketProvider>;

export const AgentConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  /** Serveur MCP du core — l'unique porte d'entrée de l'agent sur la maison (spec §10). */
  coreMcpUrl: z
    .string()
    .default('http://127.0.0.1:8851/mcp')
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      'AGENT_CORE_MCP_URL doit commencer par http:// ou https://',
    ),
  /** Prise HTTP du service (future « conversation agent » de HA, P8). */
  port: port(8852),
  /** Loopback : le service n'est pas authentifié (spec §14). */
  host: z.string().default('127.0.0.1'),
  /** Budget de temps d'un tour, garde-fou de la spec §11. */
  turnTimeoutMs: positiveMs(120_000),
  /** Plafond de boucle d'outils : un tour qui part en vrille coûte cher. */
  maxTurns: z.coerce.number().int().positive().default(20),
  /** Tours simultanés acceptés par la prise HTTP ; au-delà, 429. */
  maxConcurrentTurns: z.coerce.number().int().positive().default(2),
  /** Absent = modèle par défaut du SDK. */
  model: z.string().min(1).optional(),
  /** Lu (jamais écrit) pour construire le prompt du planner et le diff des propositions. */
  regulationConfigPath: z.string().default('config/regulation.yaml'),
  /** Destination des propositions de l'agent — jamais versionnée (cf. README de la phase). */
  proposalsDir: z.string().default('config/proposals'),
  /** Cumul quotidien du budget. */
  usageDir: z.string().default('data'),
  marketProvider: MarketProvider.default('fake'),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/** Une variable d'environnement vide vaut absente. */
const orUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return AgentConfig.parse({
    mqttUrl: orUndefined(env.STELLAR_MQTT_URL),
    coreMcpUrl: orUndefined(env.AGENT_CORE_MCP_URL),
    port: orUndefined(env.AGENT_PORT),
    host: orUndefined(env.AGENT_HOST),
    turnTimeoutMs: orUndefined(env.AGENT_TURN_TIMEOUT_MS),
    maxTurns: orUndefined(env.AGENT_MAX_TURNS),
    maxConcurrentTurns: orUndefined(env.AGENT_MAX_CONCURRENT_TURNS),
    model: orUndefined(env.AGENT_MODEL),
    regulationConfigPath: orUndefined(env.CORE_REGULATION_FILE),
    proposalsDir: orUndefined(env.AGENT_PROPOSALS_DIR),
    usageDir: orUndefined(env.AGENT_USAGE_DIR),
    marketProvider: orUndefined(env.MARKET_PROVIDER),
  });
}
