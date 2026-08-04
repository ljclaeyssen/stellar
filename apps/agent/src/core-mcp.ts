import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { Entity, type Selector } from '@stellar/contracts';

/**
 * Client MCP du core, côté agent — **hors LLM**.
 *
 * Le modèle appelle les tools du core à travers le SDK ; ce module sert le cas
 * inverse : le code de l'agent (le planner) a besoin de quelques états *avant*
 * d'ouvrir une session, pour les mettre dans le prompt. Passer par la même porte
 * MCP plutôt que par le bus n'est pas un détour : c'est ce qui garantit que le
 * planner voit exactement la maison que l'agent verra, avec les mêmes garde-fous
 * (spec §10 : « unique porte d'entrée de l'agent »).
 */

const CLIENT_NAME = 'stellar-agent';
const CLIENT_VERSION = '0.1.0';

/** Forme d'un résultat de tool MCP, resserrée sur ce que le core produit. */
interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

const StateResult = z.object({ entities: z.array(Entity) });
const RegulationResult = z.object({ path: z.string(), config: z.record(z.unknown()) });

export interface RegulationSnapshot {
  path: string;
  config: Record<string, unknown>;
}

export interface CoreMcpClient {
  /** États du miroir pour un sélecteur (`kind` + `room`, jamais un nom de driver). */
  getStates(selector: Selector): Promise<Entity[]>;
  /** `undefined` si le core n'a pas de configuration de régulation branchée. */
  getRegulationConfig(): Promise<RegulationSnapshot | undefined>;
  close(): Promise<void>;
}

export async function connectCoreMcp(url: string): Promise<CoreMcpClient> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('');
    return { isError: result.isError === true, text, data: result.structuredContent ?? {} };
  };

  return {
    async getStates(selector) {
      const outcome = await call('get_state', { ...selector });
      if (outcome.isError) throw new Error(`get_state a échoué : ${outcome.text}`);
      const parsed = StateResult.safeParse(outcome.data);
      // Une entité hors contrat côté core ne doit pas faire tomber le planner :
      // mieux vaut un brief incomplet qu'un brief absent (spec §4 n°4).
      return parsed.success ? parsed.data.entities : [];
    },
    async getRegulationConfig() {
      const outcome = await call('get_regulation_config');
      if (outcome.isError) return undefined;
      const parsed = RegulationResult.safeParse(outcome.data);
      return parsed.success ? parsed.data : undefined;
    },
    async close() {
      await client.close();
    },
  };
}
