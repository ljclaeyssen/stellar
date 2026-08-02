import { z } from 'zod';

// 'cover', 'button', 'doorbell', 'lock' : réservés futur — 'lock' n'est JAMAIS piloté par l'agent.
export const Kind = z.enum([
  'temperature',
  'humidity',
  'presence',
  'power',
  'climate',
  'light',
  'plug',
  'media',
  'tempo',
  'weather',
  'cover',
  'button',
  'doorbell',
  'lock',
]);
export type Kind = z.infer<typeof Kind>;
