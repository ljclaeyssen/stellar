import { z } from 'zod';
import { Kind } from './kind.js';

export const EntityDecl = z.object({
  id: z.string(),
  kind: Kind,
  room: z.string().optional(),
  unit: z.string().optional(),
});
export type EntityDecl = z.infer<typeof EntityDecl>;

export const Manifest = z.object({
  driver: z.string(),
  version: z.string(),
  entities: z.array(EntityDecl),
  commands: z.array(
    z.object({
      action: z.string(),
      /** JSON Schema des params (export zod-to-json-schema côté driver) */
      paramsSchema: z.record(z.unknown()),
    }),
  ),
});
export type Manifest = z.infer<typeof Manifest>;
