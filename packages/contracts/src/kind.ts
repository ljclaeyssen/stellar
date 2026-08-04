import { z } from 'zod';

// 'cover' : ouvert en P9 (CoverValue, cf. values.ts) — c'était la « PR partagée »
// de la spec §7, faite une fois pour toute la famille des ouvrants motorisés.
// 'button', 'doorbell' : réservés futur (événementiels, cf. home/event/…).
// 'lock' : réservé futur ET jamais piloté par l'agent, quel que soit son contrat.
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
