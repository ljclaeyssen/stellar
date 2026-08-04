import { z } from 'zod';

/**
 * Config par variables d'environnement — **aucun secret** : ce driver ne parle à
 * rien d'autre qu'au bus. C'est le « nouveau device dans six mois » de la spec
 * §13 : tout ce qui le concerne tient dans son package.
 */
export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  entityId: z.string().min(1).default('volet_salon'),
  room: z.string().min(1).default('salon'),
  /**
   * Délai entre deux pas de course (5 % chacun) : 200 ms ⇒ 4 s de course
   * complète, assez lent pour voir passer `opening`/`closing` sur le bus, assez
   * rapide pour un test. Un vrai volet met une vingtaine de secondes.
   */
  speedMs: z.coerce
    .number()
    .int()
    .positive('durée en ms strictement positive attendue')
    .default(200),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    entityId: env.FAKESHUTTER_ENTITY_ID,
    room: env.FAKESHUTTER_ROOM,
    speedMs: env.FAKESHUTTER_SPEED_MS,
  });
}
