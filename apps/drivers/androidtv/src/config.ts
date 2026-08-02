import { z } from 'zod';

/**
 * Config par variables d'environnement. Le certificat de pairing est un fichier
 * JSON local (gitignoré) — à chiffrer sops/age une fois la procédure stabilisée.
 */
export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  tvHost: z.string().min(1, 'ATV_HOST requis (IP fixe de la TV)'),
  entityId: z.string().default('tv_salon'),
  room: z.string().default('salon'),
  certFile: z.string().default('config/androidtv-cert.json'),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    tvHost: env.ATV_HOST,
    entityId: env.ATV_ENTITY_ID,
    room: env.ATV_ROOM,
    certFile: env.ATV_CERT_FILE,
  });
}
