import { z } from 'zod';
import { Kind } from './kind.js';
import { valueSchemas } from './values.js';

export const Entity = z.object({
  id: z.string(),
  driver: z.string(),
  kind: Kind,
  room: z.string().optional(),
  value: z.unknown(),
  unit: z.string().optional(),
  ts: z.string().datetime(),
  stale: z.boolean().optional(),
});
export type Entity = z.infer<typeof Entity>;

/**
 * Valide l'enveloppe Entity PUIS le `value` selon le schéma dédié au `kind`.
 * C'est la validation à utiliser aux frontières de process (règle n°4 de la spec).
 */
export const TypedEntity = Entity.superRefine((entity, ctx) => {
  const schema = valueSchemas[entity.kind];
  const result = schema.safeParse(entity.value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value', ...issue.path],
        message: `value invalide pour kind '${entity.kind}': ${issue.message}`,
      });
    }
  }
});

export function parseEntity(input: unknown): Entity {
  return TypedEntity.parse(input);
}

export function safeParseEntity(input: unknown): z.SafeParseReturnType<unknown, Entity> {
  return TypedEntity.safeParse(input);
}
