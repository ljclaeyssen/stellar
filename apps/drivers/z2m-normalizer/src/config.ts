import { z } from 'zod';

/**
 * Config par variables d'environnement. **Aucun secret ici** : Zigbee2MQTT
 * publie sur le même broker que le bus, et la table de mapping est publique
 * (elle est versionnée, cf. `.gitignore`). C'est le seul driver du parc sans
 * couple token/clé — l'appairage Zigbee se fait côté Z2M, pas côté Stellar.
 */
const positiveMs = (fallback: number) =>
  z.coerce.number().int().positive('durée en ms strictement positive attendue').default(fallback);

export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  /** Racine des topics Z2M — `mqtt.base_topic` de la configuration Zigbee2MQTT. */
  baseTopic: z
    .string()
    .min(1)
    .default('zigbee2mqtt')
    .refine(
      (value) => !value.includes('#') && !value.includes('+') && !value.endsWith('/'),
      'Z2M_BASE_TOPIC : pas de joker MQTT ni de / final',
    ),
  mappingFile: z.string().default('config/z2m-mapping.json'),
  /** Destination des dumps `dump` (checklist matériel, docs/TESTING.md §3). */
  fixturesDir: z.string().default('apps/drivers/z2m-normalizer/__fixtures__'),
  /** Durée d'écoute de la commande `dump`. */
  dumpDurationMs: positiveMs(30_000),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    baseTopic: env.Z2M_BASE_TOPIC,
    mappingFile: env.Z2M_MAPPING_FILE,
    fixturesDir: env.Z2M_FIXTURES_DIR,
    dumpDurationMs: env.Z2M_DUMP_DURATION_MS,
  });
}
