import { z } from 'zod';

/**
 * Config par variables d'environnement.
 *
 * L'application key du bridge est un secret : soit `HUE_APP_KEY` (injectée par
 * l'orchestrateur depuis sops/age), soit `HUE_APP_KEY_FILE` — un JSON local
 * `{ "applicationKey": "…" }` produit par `stellar-hue pair`, gitignoré
 * (`config/*`) et **à chiffrer sops/age avant tout backup**.
 */
export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  bridgeUrl: z
    .string({ required_error: 'HUE_BRIDGE_URL requis (ex. https://192.168.1.10)' })
    .min(1, 'HUE_BRIDGE_URL requis (ex. https://192.168.1.10)')
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      'HUE_BRIDGE_URL doit commencer par http:// ou https://',
    ),
  appKey: z.string().min(1).optional(),
  appKeyFile: z.string().default('config/hue-app-key.json'),
  /** Destination des dumps `verify` (checklist matériel, docs/TESTING.md §3). */
  fixturesDir: z.string().default('apps/drivers/hue/__fixtures__'),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

/** Fichier produit par le pairing — `clientKey` n'est utile qu'au streaming Entertainment. */
export const AppKeyFile = z.object({
  applicationKey: z.string().min(1),
  clientKey: z.string().optional(),
});
export type AppKeyFile = z.infer<typeof AppKeyFile>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    bridgeUrl: env.HUE_BRIDGE_URL,
    appKey: env.HUE_APP_KEY,
    appKeyFile: env.HUE_APP_KEY_FILE,
    fixturesDir: env.HUE_FIXTURES_DIR,
  });
}
