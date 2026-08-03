import { z } from 'zod';
import type { Kind } from './kind.js';

export const ClimateMode = z.enum(['heat', 'cool', 'fan', 'dry', 'auto']);
export type ClimateMode = z.infer<typeof ClimateMode>;

/** °C — bornes physiques plausibles pour une sonde domestique/extérieure. */
export const TemperatureValue = z.number().min(-50).max(80);
/** % HR */
export const HumidityValue = z.number().min(0).max(100);
export const PresenceValue = z.boolean();

/** Linky/ZLinky — index HP/HC et détails ajoutés en P5, d'où le passthrough. */
export const PowerValue = z
  .object({
    va: z.number().nonnegative(),
    indexBase: z.number().nonnegative().optional(),
  })
  .passthrough();

export const ClimateValue = z.object({
  power: z.boolean(),
  mode: ClimateMode,
  targetTemp: z.number(),
  indoorTemp: z.number().optional(),
  fan: z.string(),
});

export const LightValue = z.object({
  on: z.boolean(),
  /** 0–100 */
  brightness: z.number().min(0).max(100).optional(),
  /** affiné en P2 avec les modèles couleur CLIP v2 (xy, mirek…) */
  color: z.record(z.unknown()).optional(),
});

export const PlugValue = z.object({ on: z.boolean() });

export const MediaValue = z.object({
  power: z.boolean(),
  currentApp: z.string().optional(),
  /** 0–100 */
  volume: z.number().min(0).max(100).optional(),
});

export const TempoCouleur = z.enum(['bleu', 'blanc', 'rouge']);
export const TempoValue = z.object({
  couleurJour: TempoCouleur,
  couleurDemain: z.enum(['bleu', 'blanc', 'rouge', 'inconnue']),
  periode: z.enum(['HP', 'HC']),
});

/** affiné en P3 (station Netatmo) */
export const WeatherValue = z.record(z.unknown());

/** kinds réservés futur : aucune contrainte tant que le besoin n'existe pas */
const ReservedValue = z.unknown();

/**
 * `satisfies` plutôt qu'une annotation `Record<Kind, z.ZodTypeAny>` : on garde le
 * type précis de chaque schéma (indispensable aux guards typés de `guards.ts`)
 * tout en garantissant l'exhaustivité sur `Kind`.
 */
export const valueSchemas = {
  temperature: TemperatureValue,
  humidity: HumidityValue,
  presence: PresenceValue,
  power: PowerValue,
  climate: ClimateValue,
  light: LightValue,
  plug: PlugValue,
  media: MediaValue,
  tempo: TempoValue,
  weather: WeatherValue,
  cover: ReservedValue,
  button: ReservedValue,
  doorbell: ReservedValue,
  lock: ReservedValue,
} satisfies Record<Kind, z.ZodTypeAny>;

export type TemperatureValue = z.infer<typeof TemperatureValue>;
export type HumidityValue = z.infer<typeof HumidityValue>;
export type PresenceValue = z.infer<typeof PresenceValue>;
export type PowerValue = z.infer<typeof PowerValue>;
export type ClimateValue = z.infer<typeof ClimateValue>;
export type LightValue = z.infer<typeof LightValue>;
export type PlugValue = z.infer<typeof PlugValue>;
export type MediaValue = z.infer<typeof MediaValue>;
export type TempoValue = z.infer<typeof TempoValue>;
export type WeatherValue = z.infer<typeof WeatherValue>;
