import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Config par variables d'environnement.
 *
 * Le trio **id / token / key** de chaque unité ne peut pas passer par des
 * variables d'environnement : il y en a trois par clim, ils sont longs, et ils
 * sont irremplaçables (Midea ferme ses API de délivrance — spec §9, ADR-005). Ils
 * vivent donc dans un fichier JSON, `MIDEA_UNITS_FILE`, **gitignoré**
 * (`config/*` est en allowlist) et **à chiffrer sops/age** :
 *
 * ```bash
 * pnpm secrets:encrypt config/midea-units.json   # → chiffre en place
 * ```
 *
 * Ce fichier est produit à l'atelier P4.0 (`midea-discover`, TODO_LJ.md).
 */
const positiveMs = (fallback: number) =>
  z.coerce.number().int().positive('durée en ms strictement positive attendue').default(fallback);

/**
 * Une unité = une clim + son dongle. `entityId` et `room` sont fournis par
 * l'humain (le dongle ne sait pas dans quelle pièce il est) ; `host`, `id`,
 * `token`, `key` sortent de `midea-discover`.
 */
export const MideaUnit = z
  .object({
    /** `clim_<room>` (spec §6, snake_case). */
    entityId: z.string().min(1),
    room: z.string().min(1),
    /** IP **fixe** du dongle : le discovery broadcast peut être filtré par le mesh (spec §3). */
    host: z.string().min(1),
    id: z.string().min(1),
    token: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();
export type MideaUnit = z.infer<typeof MideaUnit>;

/** Trois unités attendues (salon, entree, chambre) — mais N est accepté sans code à changer. */
export const MideaUnits = z
  .array(MideaUnit)
  .min(1, 'au moins une unité attendue dans MIDEA_UNITS_FILE')
  .superRefine((units, ctx) => {
    const seen = new Set<string>();
    for (const unit of units) {
      if (seen.has(unit.entityId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entityId dupliqué: ${unit.entityId}`,
        });
      }
      seen.add(unit.entityId);
    }
  });
export type MideaUnits = z.infer<typeof MideaUnits>;

export const DriverConfig = z.object({
  mqttUrl: z.string().default('mqtt://localhost:1883'),
  unitsFile: z.string().default('config/midea-units.json'),
  /**
   * Spec §9 / ADR-005 : « polling doux 30–60 s ». Le SK103 décroche du WiFi et
   * réclame un power-cycle quand on le sollicite trop — c'est la contrainte
   * structurante de cette phase, pas un réglage de confort. Les tests descendent
   * à quelques dizaines de ms ; **jamais la prod**.
   */
  pollMs: positiveMs(45_000),
  /**
   * Spec §9 : « alerte si injoignable > 5 min ». Traduit en nombre de cycles ratés
   * consécutifs par `staleAfterCycles()` — voir driver.ts.
   */
  staleAfterMs: positiveMs(300_000),
  /** Destination des dumps `verify` (checklist matériel, docs/TESTING.md §3). */
  fixturesDir: z.string().default('apps/drivers/midea/__fixtures__'),
});
export type DriverConfig = z.infer<typeof DriverConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  return DriverConfig.parse({
    mqttUrl: env.STELLAR_MQTT_URL,
    unitsFile: env.MIDEA_UNITS_FILE,
    pollMs: env.MIDEA_POLL_MS,
    staleAfterMs: env.MIDEA_STALE_AFTER_MS,
    fixturesDir: env.MIDEA_FIXTURES_DIR,
  });
}

/**
 * Message d'aide quand le fichier d'unités manque. Il n'y a **pas de commande
 * `pair`** ici : l'obtention des token/key passe par le cloud Midea via
 * `midea-discover`, en atelier, depuis le LAN de la maison — le driver ne peut
 * que dire clairement quoi faire.
 */
export const MISSING_UNITS_HELP =
  'fichier des unités Midea introuvable ou illisible — atelier P4.0 requis : ' +
  'depuis le LAN de la maison (pas Docker/VM, le discovery est un broadcast UDP), ' +
  '`npx midea-discover --user=<compte SmartHome> --password=<mdp>` → noter id/token/key/IP ' +
  'des 3 unités, puis écrire un tableau JSON ' +
  '[{"entityId":"clim_salon","room":"salon","host":"…","id":"…","token":"…","key":"…"}] ' +
  'dans ce fichier et le chiffrer (`pnpm secrets:encrypt`). Procédure complète dans TODO_LJ.md §P4.0.';

export async function loadUnits(file: string): Promise<MideaUnits> {
  const raw = await readFile(file, 'utf8');
  return MideaUnits.parse(JSON.parse(raw));
}
