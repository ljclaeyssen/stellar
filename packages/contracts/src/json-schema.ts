import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Export JSON Schema (manifestes discovery, tools MCP). */
export function toJsonSchema(schema: z.ZodTypeAny, name?: string): Record<string, unknown> {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}
