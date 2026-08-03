import { z } from 'zod';
import type { ClimateMode, ClimateValue } from '@stellar/contracts';
import {
  MIDEA_FAN_SPEED_AUTO,
  MIDEA_FAN_SPEED_BY_NAME,
  MIDEA_FAN_SPEED_FIXED,
  MIDEA_MODE_BY_VALUE,
  type MideaFanSpeedName,
  type MideaModeName,
  type MideaStatus,
  type MideaStatusPatch,
} from './status.js';

/** Traduction impossible : le contrat et l'équipement ne se recouvrent pas ici. */
export class MideaMappingError extends Error {
  override readonly name = 'MideaMappingError';
}

/**
 * Modes Midea → `ClimateMode` du contrat (packages/contracts, §7).
 *
 * `customdry` (6) n'a pas d'équivalent : c'est un déshumidificateur à consigne
 * d'humidité, fonctionnellement du `dry`. On le rapporte donc en `dry` — mentir
 * un peu vaut mieux que rendre une unité illisible pour tout le système. Il n'est
 * en revanche **jamais** écrit par Stellar (voir `MODE_TO_MIDEA`).
 */
const MODE_TO_CONTRACT = {
  1: 'auto',
  2: 'cool',
  3: 'dry',
  4: 'heat',
  5: 'fan',
  6: 'dry',
} as const satisfies Record<keyof typeof MIDEA_MODE_BY_VALUE, ClimateMode>;

/** `ClimateMode` → nom de mode attendu par `setStatus` (`lib/ac.js`). */
const MODE_TO_MIDEA = {
  auto: 'auto',
  cool: 'cool',
  dry: 'dry',
  heat: 'heat',
  fan: 'fanonly',
} as const satisfies Record<ClimateMode, MideaModeName>;

const isKnownMode = (mode: number): mode is keyof typeof MODE_TO_CONTRACT =>
  Object.hasOwn(MODE_TO_CONTRACT, mode);

/**
 * `fanSpeed` (0–100 %, 101 « fixed », 102 « auto ») → chaîne du contrat.
 *
 * Écart assumé avec un `String(fanSpeed)` littéral : les deux sentinelles hors
 * échelle sont rendues par leur nom. Sans ça, `fan: "102"` ne peut pas revenir
 * par `climatePatchToStatus` (le patch borne les nombres à 0–100, 102 serait
 * refusé) — l'aller-retour, qui est la seule garantie utile d'un mapping, serait
 * cassé pour le réglage le plus courant du parc.
 */
export function fanSpeedToContract(fanSpeed: number): string {
  if (fanSpeed === MIDEA_FAN_SPEED_AUTO) return 'auto';
  if (fanSpeed === MIDEA_FAN_SPEED_FIXED) return 'fixed';
  return String(fanSpeed);
}

const isFanSpeedName = (fan: string): fan is MideaFanSpeedName =>
  Object.hasOwn(MIDEA_FAN_SPEED_BY_NAME, fan);

/**
 * Chaîne du contrat → valeur acceptée par `setStatus` : un nom
 * (`silent|low|medium|high|auto`) ou un pourcentage `0–100`.
 *
 * `fixed` est lisible mais **non écrivable** : la table d'écriture de `lib/ac.js`
 * ne le connaît pas. Le refuser ici, c'est refuser tôt et clairement plutôt que
 * de laisser l'unité recevoir une trame absurde.
 */
export function fanSpeedFromContract(fan: string): MideaFanSpeedName | number {
  if (isFanSpeedName(fan)) return fan;
  const percent = Number(fan);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new MideaMappingError(
      `vitesse de ventilation inconnue: ${JSON.stringify(fan)} (attendu: ${Object.keys(MIDEA_FAN_SPEED_BY_NAME).join('|')} ou un entier 0-100)`,
    );
  }
  return percent;
}

/** Statut normalisé d'une unité → `ClimateValue` du contrat. */
export function statusToClimateValue(status: MideaStatus): ClimateValue {
  if (!isKnownMode(status.mode)) {
    throw new MideaMappingError(
      `mode Midea inconnu: ${String(status.mode)} (attendu 1-6, cf. lib/reporter.js)`,
    );
  }
  return {
    power: status.powerOn,
    mode: MODE_TO_CONTRACT[status.mode],
    targetTemp: status.temperatureSetpoint,
    ...(status.indoorTemperature === undefined ? {} : { indoorTemp: status.indoorTemperature }),
    fan: fanSpeedToContract(status.fanSpeed),
  };
}

/**
 * Paramètres d'une commande `set` côté contrat. Ce sont *ceux du driver* : le
 * mapping est le seul endroit qui connaisse à la fois les deux vocabulaires, donc
 * le seul endroit où ces bornes ont un sens vérifiable.
 *
 * 16–31 °C : bornes exactes de `setStatus` en Celsius (`lib/ac.js`).
 */
export const ClimatePatch = z
  .object({
    power: z.boolean().optional(),
    mode: z.enum(['auto', 'cool', 'dry', 'heat', 'fan']).optional(),
    targetTemp: z.number().min(16).max(31).optional(),
    fan: z.string().optional(),
  })
  .strict();
export type ClimatePatch = z.infer<typeof ClimatePatch>;

/** `ClimateValue` partiel du contrat → patch `setStatus`. Inverse de `statusToClimateValue`. */
export function climatePatchToStatus(params: ClimatePatch): MideaStatusPatch {
  return {
    ...(params.power === undefined ? {} : { powerOn: params.power }),
    ...(params.mode === undefined ? {} : { mode: MODE_TO_MIDEA[params.mode] }),
    ...(params.targetTemp === undefined ? {} : { temperatureSetpoint: params.targetTemp }),
    ...(params.fan === undefined ? {} : { fanSpeed: fanSpeedFromContract(params.fan) }),
  };
}
