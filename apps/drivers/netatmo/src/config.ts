import { z } from 'zod';

/**
 * Config par variables d'environnement.
 *
 * `NETATMO_CLIENT_ID` / `NETATMO_CLIENT_SECRET` viennent de l'app OAuth créée sur
 * dev.netatmo.com (injectées par l'orchestrateur depuis sops/age). Le **refresh
 * token**, lui, vit dans un fichier JSON local `{ "refreshToken": "…" }`
 * (`NETATMO_TOKEN_FILE`) : le driver le fait tourner à chaque rafraîchissement et
 * doit pouvoir le réécrire — un secret injecté en variable d'environnement serait
 * perdu au premier redémarrage. Ce fichier est gitignoré (`config/*` en allowlist,
 * plus le filet `**\/*token*.json`) et **à chiffrer sops/age avant tout backup**.
 */
const positiveMs = (fallback: number) =>
  z.coerce.number().int().positive('durée en ms strictement positive attendue').default(fallback);

export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  /** api.netatmo.com en prod ; l'URL du simulateur en test/dev. */
  apiUrl: z
    .string()
    .default('https://api.netatmo.com')
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      'NETATMO_API_URL doit commencer par http:// ou https://',
    ),
  clientId: z
    .string({ required_error: 'NETATMO_CLIENT_ID requis (app OAuth dev.netatmo.com)' })
    .min(1, 'NETATMO_CLIENT_ID requis (app OAuth dev.netatmo.com)'),
  clientSecret: z
    .string({ required_error: 'NETATMO_CLIENT_SECRET requis (app OAuth dev.netatmo.com)' })
    .min(1, 'NETATMO_CLIENT_SECRET requis (app OAuth dev.netatmo.com)'),
  tokenFile: z.string().default('config/netatmo-token.json'),
  /**
   * Cadences de polling (spec §9 : « polling raisonnable : 5 min météo,
   * 1–2 min thermostat »). Surchargeables en ms — les tests descendent à ~50 ms.
   */
  thermostatIntervalMs: positiveMs(90_000),
  stationIntervalMs: positiveMs(300_000),
  /** Retry doux quand l'authentification est morte (spec : ne pas marteler l'API). */
  authRetryMs: positiveMs(900_000),
  /** Destination des dumps `verify` (checklist matériel, docs/TESTING.md §3). */
  fixturesDir: z.string().default('apps/drivers/netatmo/__fixtures__'),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

/**
 * Contenu de `NETATMO_TOKEN_FILE`. `rotatedAt` est purement informatif (savoir
 * d'un coup d'œil si le driver fait bien tourner le token) ; seul `refreshToken`
 * compte. `passthrough` : un champ ajouté à la main ne doit pas rendre le fichier
 * illisible et forcer une réauthentification.
 */
export const TokenFile = z
  .object({
    refreshToken: z.string().min(1),
    rotatedAt: z.string().optional(),
  })
  .passthrough();
export type TokenFile = z.infer<typeof TokenFile>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    apiUrl: env.NETATMO_API_URL,
    clientId: env.NETATMO_CLIENT_ID,
    clientSecret: env.NETATMO_CLIENT_SECRET,
    tokenFile: env.NETATMO_TOKEN_FILE,
    thermostatIntervalMs: env.NETATMO_THERMOSTAT_INTERVAL_MS,
    stationIntervalMs: env.NETATMO_STATION_INTERVAL_MS,
    authRetryMs: env.NETATMO_AUTH_RETRY_MS,
    fixturesDir: env.NETATMO_FIXTURES_DIR,
  });
}
