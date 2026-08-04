import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/** Frontière de process : la config est validée par zod, comme partout (spec §4 n°4). */
describe('configuration du service agent', () => {
  it('a des défauts utilisables sans aucune variable d’environnement', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8852);
    expect(config.host).toBe('127.0.0.1');
    expect(config.coreMcpUrl).toBe('http://127.0.0.1:8851/mcp');
    expect(config.turnTimeoutMs).toBe(120_000);
    expect(config.marketProvider).toBe('fake');
    expect(config.proposalsDir).toBe('config/proposals');
    // La clé d'API n'est pas une donnée de config : elle n'est exigée qu'au
    // démarrage du service réel, jamais en test.
    expect(Object.keys(config)).not.toContain('anthropicApiKey');
  });

  it('lit l’environnement et refuse une valeur aberrante', () => {
    const config = loadConfig({
      AGENT_PORT: '9000',
      AGENT_TURN_TIMEOUT_MS: '30000',
      AGENT_CORE_MCP_URL: 'http://127.0.0.1:1234/mcp',
      MARKET_PROVIDER: 'fake',
      AGENT_USAGE_DIR: '',
    });
    expect(config.port).toBe(9000);
    expect(config.turnTimeoutMs).toBe(30_000);
    expect(config.coreMcpUrl).toBe('http://127.0.0.1:1234/mcp');
    // Variable vide = absente : on retombe sur le défaut plutôt que sur un chemin vide.
    expect(config.usageDir).toBe('data');

    expect(() => loadConfig({ AGENT_PORT: '99999' })).toThrow();
    expect(() => loadConfig({ AGENT_TURN_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadConfig({ AGENT_CORE_MCP_URL: 'mqtt://localhost' })).toThrow();
    expect(() => loadConfig({ MARKET_PROVIDER: 'inventé' })).toThrow();
  });
});
