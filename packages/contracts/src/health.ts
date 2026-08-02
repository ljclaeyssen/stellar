import { z } from 'zod';

/** `home/health/<driver>` — LWT côté broker pour 'offline', publié par le driver pour 'online'. */
export const Health = z.object({
  status: z.enum(['online', 'offline']),
  ts: z.string().datetime(),
});
export type Health = z.infer<typeof Health>;
