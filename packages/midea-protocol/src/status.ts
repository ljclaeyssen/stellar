import { z } from 'zod';

/**
 * Modes de fonctionnement Midea, **relevés dans `lib/reporter.js`** de
 * node-mideahvac 0.3.3 (et confirmés par la table `mode` de `lib/ac.js`
 * `setStatus`) : 1 auto · 2 cool · 3 dry · 4 heat · 5 fanonly · 6 customdry.
 *
 * La lecture (`getStatus`) rend un **numéro**, l'écriture (`setStatus`) attend la
 * **chaîne**. D'où les deux tables : ce n'est pas une redondance, c'est
 * l'asymétrie réelle de la lib.
 */
export const MIDEA_MODE_BY_VALUE = {
  1: 'auto',
  2: 'cool',
  3: 'dry',
  4: 'heat',
  5: 'fanonly',
  6: 'customdry',
} as const satisfies Record<number, string>;

export type MideaModeName = (typeof MIDEA_MODE_BY_VALUE)[keyof typeof MIDEA_MODE_BY_VALUE];

export const MideaModeName = z.enum(['auto', 'cool', 'dry', 'heat', 'fanonly', 'customdry']);

/**
 * Vitesses de ventilation nommées acceptées par `setStatus`, table relevée dans
 * `lib/ac.js` : `{ auto: 102, silent: 20, low: 40, medium: 60, high: 80 }`.
 * `getStatus` rend le pourcentage brut (0–100), plus 101 « fixed » et 102 « auto ».
 */
export const MIDEA_FAN_SPEED_BY_NAME = {
  silent: 20,
  low: 40,
  medium: 60,
  high: 80,
  auto: 102,
} as const satisfies Record<string, number>;

export type MideaFanSpeedName = keyof typeof MIDEA_FAN_SPEED_BY_NAME;

export const MideaFanSpeedName = z.enum(['silent', 'low', 'medium', 'high', 'auto']);

/** 101 = « fixed », 102 = « auto » (lib/reporter.js) — hors échelle 0–100 %. */
export const MIDEA_FAN_SPEED_FIXED = 101;
export const MIDEA_FAN_SPEED_AUTO = 102;

/**
 * État **normalisé** d'une unité : la forme que le reste de Stellar consomme.
 *
 * Écart assumé avec la lib : `lib/reporter.js` rapporte `mode` et `fanSpeed` en
 * `{ value, description }`. Un objet à deux champs dont un seul fait foi n'a rien
 * à faire dans un contrat — `normalizeStatus` l'aplatit sur `value`, la
 * description étant reconstructible (`MIDEA_MODE_BY_VALUE`).
 *
 * `passthrough` : la lib rapporte des dizaines d'autres propriétés (turboMode,
 * ecoMode, `byte3bit4`…) qui varient d'un modèle à l'autre. On les laisse passer
 * intactes plutôt que de les perdre — les fixtures `verify` en profitent.
 */
export const MideaStatus = z
  .object({
    powerOn: z.boolean(),
    mode: z.number().int(),
    temperatureSetpoint: z.number(),
    indoorTemperature: z.number().optional(),
    fanSpeed: z.number().int(),
  })
  .passthrough();
export type MideaStatus = z.infer<typeof MideaStatus>;

/**
 * Patch d'écriture, tel que `setStatus` de la lib l'attend (`lib/ac.js`) :
 * `mode` en chaîne, `fanSpeed` en chaîne nommée **ou** pourcentage 0–100,
 * `temperatureSetpoint` borné 16–31 °C (bornes exactes de la lib, qui rejette
 * hors de cet intervalle en Celsius).
 *
 * `strict` : une propriété inconnue est une erreur d'appelant, pas une donnée à
 * transmettre à l'aveugle à un équipement qui décroche quand on le brusque.
 */
export const MideaStatusPatch = z
  .object({
    powerOn: z.boolean().optional(),
    mode: MideaModeName.optional(),
    temperatureSetpoint: z.number().min(16).max(31).optional(),
    fanSpeed: z.union([z.number().int().min(0).max(100), MideaFanSpeedName]).optional(),
  })
  .strict();
export type MideaStatusPatch = z.infer<typeof MideaStatusPatch>;

/** Forme brute rendue par `lib/reporter.js` pour les champs à description. */
const Reported = z.union([
  z.number(),
  z.object({ value: z.number(), description: z.string().optional() }),
]);

const flatten = (reported: z.infer<typeof Reported>): number =>
  typeof reported === 'number' ? reported : reported.value;

/**
 * Payload brut de `getStatus` / `setStatus`. Volontairement permissif sur tout ce
 * qui n'est pas indispensable : un firmware qui ne rapporte pas `indoorTemperature`
 * ne doit pas faire tomber le driver, il doit publier un `climate` sans `indoorTemp`.
 */
export const MideaRawStatus = z
  .object({
    powerOn: z.boolean(),
    mode: Reported,
    temperatureSetpoint: z.number(),
    indoorTemperature: z.number().optional(),
    fanSpeed: Reported,
  })
  .passthrough();
export type MideaRawStatus = z.infer<typeof MideaRawStatus>;

/**
 * Aplatit un rapport de la lib en `MideaStatus`. Lève une `ZodError` si les
 * champs structurants manquent — mieux vaut un cycle de polling en échec qu'un
 * état inventé publié en retained sur le bus (spec §4 : message invalide → jeté).
 */
export function normalizeStatus(raw: unknown): MideaStatus {
  const parsed = MideaRawStatus.parse(raw);
  return MideaStatus.parse({
    ...parsed,
    mode: flatten(parsed.mode),
    fanSpeed: flatten(parsed.fanSpeed),
  });
}
