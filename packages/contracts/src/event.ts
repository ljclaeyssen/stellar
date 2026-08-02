import { z } from 'zod';

/** `home/event/<driver>/<type>` — ponctuel, non retained. */
export const BusEvent = z.object({
  driver: z.string(),
  type: z.string(),
  data: z.unknown().optional(),
  ts: z.string().datetime(),
});
export type BusEvent = z.infer<typeof BusEvent>;
