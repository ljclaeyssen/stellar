import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MarketProvider } from '../config.js';

/**
 * `market_quote` (spec §11) — cours de bourse, tool custom in-process.
 *
 * Le **fournisseur est enfichable** parce que le vrai n'est pas encore choisi :
 * c'est une décision humaine ouverte (TODO_LJ.md §P7 — quelle API, quel abonnement,
 * quelles conditions de redistribution). Le jour où elle tombe, on ajoute une
 * implémentation de `MarketQuoteProvider` et une valeur à `MARKET_PROVIDER` ; ni le
 * tool, ni le prompt, ni l'allowlist ne bougent.
 *
 * En attendant, le provider par défaut est **explicitement faux** : prix stable par
 * symbole (pour que les tests et les démos soient reproductibles) et mention
 * « données factices » dans chaque réponse — un agent qui parle d'argent ne doit
 * jamais pouvoir faire passer un chiffre inventé pour une cotation.
 */

export interface MarketQuote {
  symbol: string;
  price: number;
  currency: string;
  /** ISO 8601 UTC, comme tous les horodatages du projet (spec §6). */
  ts: string;
  /** Vrai quand la donnée ne vient pas d'un vrai marché. */
  fake: boolean;
  /** Origine lisible de la donnée (nom du fournisseur). */
  source: string;
}

export interface MarketQuoteProvider {
  readonly name: string;
  quote(symbol: string): Promise<MarketQuote>;
}

/** Nom du serveur MCP in-process — préfixe des tools côté SDK (`mcp__<nom>__<tool>`). */
export const MARKET_MCP_SERVER_NAME = 'market';
export const MARKET_QUOTE_TOOL = 'market_quote';

const FAKE_SOURCE = 'fake-market';
const FAKE_CURRENCY = 'EUR';
/** Bornes du prix inventé : assez large pour être crédible, assez basse pour être suspecte. */
const FAKE_PRICE_MIN = 5;
const FAKE_PRICE_SPAN = 995;

/** FNV-1a 32 bits — un hachage stable, court, et sans dépendance. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Fournisseur factice : **horodaté au moment de l'appel** (le `ts` bouge), mais
 * **stable en prix** (le même symbole rend toujours le même prix). Cette asymétrie
 * est voulue : un test peut asserter le prix, et une démo montre bien qu'il s'agit
 * d'une réponse fraîche.
 */
export function createFakeMarketQuoteProvider(
  options: { clock?: () => Date } = {},
): MarketQuoteProvider {
  const clock = options.clock ?? ((): Date => new Date());
  return {
    name: FAKE_SOURCE,
    quote(symbol: string): Promise<MarketQuote> {
      const normalized = normalizeSymbol(symbol);
      const price = FAKE_PRICE_MIN + (hash32(normalized) % (FAKE_PRICE_SPAN * 100)) / 100;
      return Promise.resolve({
        symbol: normalized,
        price: Math.round(price * 100) / 100,
        currency: FAKE_CURRENCY,
        ts: clock().toISOString(),
        fake: true,
        source: FAKE_SOURCE,
      });
    },
  };
}

/** Fabrique du fournisseur configuré. Un `MARKET_PROVIDER` inconnu est refusé par zod en amont. */
export function createMarketQuoteProvider(
  provider: MarketProvider,
  options: { clock?: () => Date } = {},
): MarketQuoteProvider {
  switch (provider) {
    case 'fake':
      return createFakeMarketQuoteProvider(options);
  }
}

const FAKE_NOTICE =
  'DONNÉES FACTICES : aucun fournisseur de cotations réelles n’est encore branché. Ne présente jamais ce prix comme une cotation ; dis que la source est factice.';

export function createMarketQuoteServer(
  provider: MarketQuoteProvider,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MARKET_MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      tool(
        MARKET_QUOTE_TOOL,
        'Cours d’une valeur boursière par son symbole (ex. « AAPL »). Rend le prix, la devise et l’horodatage. Le champ `fake` dit si la donnée vient d’un vrai marché : quand il vaut true, annonce-le.',
        { symbol: z.string().min(1).describe('symbole de la valeur, ex. AAPL') },
        async (args) => {
          const quote = await provider.quote(args.symbol);
          // `Record<string, unknown>` explicite : `structuredContent` exige une
          // signature d'index, qu'une interface nommée n'a pas.
          const payload: Record<string, unknown> = quote.fake
            ? { ...quote, notice: FAKE_NOTICE }
            : { ...quote };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
          };
        },
      ),
    ],
  });
}
