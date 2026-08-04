import { z } from 'zod';

/**
 * Config par variables d'environnement.
 *
 * Particularité de ce driver : **les identifiants RTE sont facultatifs**. La
 * source primaire (API RTE, spec §9) demande un compte sur data.rte-france.com
 * et une application souscrite à « Tempo Like Supply Contract » ; le fallback
 * (api-couleur-tempo.fr) est public et sans compte. Un déploiement sans
 * identifiants est donc parfaitement valide : le driver attaque directement le
 * fallback, sans jamais appeler RTE. Les identifiants, quand ils existent,
 * viennent de sops/age via l'orchestrateur — jamais du dépôt (spec §14).
 */
const positiveMs = (fallback: number) =>
  z.coerce.number().int().positive('durée en ms strictement positive attendue').default(fallback);

const httpUrl = (fallback: string, envName: string) =>
  z
    .string()
    .default(fallback)
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      `${envName} doit commencer par http:// ou https://`,
    );

export const DriverConfig = z
  .object({
    mqttUrl: z.string().default('mqtt://localhost:1883'),
    /** Portail RTE en prod ; l'URL du simulateur en test/dev. */
    rteApiUrl: httpUrl('https://digital.iservices.rte-france.com', 'RTE_API_URL'),
    /** Absents ⇒ le driver n'appelle jamais RTE et va droit au fallback. */
    rteClientId: z.string().min(1).optional(),
    rteClientSecret: z.string().min(1).optional(),
    /** API opendata publique — le simulateur sert les deux sur le même port. */
    fallbackUrl: httpUrl('https://www.api-couleur-tempo.fr', 'TEMPO_FALLBACK_URL'),
    /**
     * Une heure. Les données ne bougent que deux fois par jour (publication du
     * lendemain vers 11 h, bascule de jour à 6 h) : marteler ces APIs n'apporte
     * rien. Les bascules HP/HC, elles, ne dépendent pas du polling — elles sont
     * programmées à la frontière exacte (cf. `driver.ts`).
     */
    pollMs: positiveMs(3_600_000),
    requestTimeoutMs: positiveMs(10_000),
    /** Destination des dumps `verify` (checklist matériel, docs/TESTING.md §3). */
    fixturesDir: z.string().default('apps/drivers/tempo/__fixtures__'),
  })
  .superRefine((config, ctx) => {
    // Un id sans secret (ou l'inverse) est un déploiement à moitié configuré :
    // basculer silencieusement sur le fallback masquerait la faute de frappe.
    const id = config.rteClientId !== undefined;
    const secret = config.rteClientSecret !== undefined;
    if (id !== secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id ? 'rteClientSecret' : 'rteClientId'],
        message:
          'RTE_CLIENT_ID et RTE_CLIENT_SECRET vont par paire (les deux, ou aucun des deux pour n’utiliser que le fallback opendata)',
      });
    }
  });
export type DriverConfig = z.infer<typeof DriverConfig>;

/** Config munie des identifiants RTE — la source primaire est utilisable. */
export type ConfigWithRte = DriverConfig & { rteClientId: string; rteClientSecret: string };

export function hasRteCredentials(config: DriverConfig): config is ConfigWithRte {
  return config.rteClientId !== undefined && config.rteClientSecret !== undefined;
}

/** Une variable d'environnement vide vaut absente (secret non injecté). */
const orUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    rteApiUrl: env.RTE_API_URL,
    rteClientId: orUndefined(env.RTE_CLIENT_ID),
    rteClientSecret: orUndefined(env.RTE_CLIENT_SECRET),
    fallbackUrl: env.TEMPO_FALLBACK_URL,
    pollMs: env.TEMPO_POLL_MS,
    requestTimeoutMs: env.TEMPO_REQUEST_TIMEOUT_MS,
    fixturesDir: env.TEMPO_FIXTURES_DIR,
  });
}
