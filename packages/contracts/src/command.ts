import { z } from 'zod';

export const IssuedBy = z.enum(['core', 'agent', 'voice', 'ui', 'cli']);
export type IssuedBy = z.infer<typeof IssuedBy>;

export const Command = z.object({
  id: z.string().uuid(),
  target: z.string(),
  action: z.string(),
  params: z.record(z.unknown()),
  issuedBy: IssuedBy,
  ts: z.string().datetime(),
});
export type Command = z.infer<typeof Command>;

export const Ack = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['ok', 'rejected', 'timeout']),
  reason: z.string().optional(),
});
export type Ack = z.infer<typeof Ack>;
