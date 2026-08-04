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

/**
 * Mouvement d'un volet — vocabulaire commun à tous les ouvrants motorisés
 * (Zigbee, moteur filaire piloté par une prise, simulateur).
 *
 * `open`/`closed` décrivent un volet **au repos** aux extrémités de sa course,
 * `stopped` un volet au repos entre les deux ; `opening`/`closing` sont les états
 * transitoires. C'est aussi le vocabulaire de Home Assistant, ce qui évite au pont
 * de traduire (spec §10 : aucune logique côté HA).
 */
export const CoverState = z.enum(['open', 'closed', 'opening', 'closing', 'stopped']);
export type CoverState = z.infer<typeof CoverState>;

/**
 * `cover` (spec §7, « une famille d'objets = une PR partagée ») — volets, stores,
 * rideaux motorisés.
 *
 * `position` est la **seule** donnée obligatoire, en pourcentage d'ouverture :
 * **0 = fermé, 100 = ouvert**, dans le sens de la convention Home Assistant et de
 * Zigbee2MQTT. Un volet sans retour de position n'existe pas dans ce contrat : le
 * driver qui n'en a pas doit publier ce qu'il croit (0 ou 100), ce qui reste plus
 * exploitable qu'une absence.
 *
 * `state` est optionnel parce qu'il est **dérivable** de la position au repos ; il
 * n'ajoute d'information que pendant le mouvement (`opening`/`closing`), que seul
 * le driver connaît.
 */
export const CoverValue = z.object({
  /** % d'ouverture — 0 fermé, 100 ouvert. */
  position: z.number().min(0).max(100),
  state: CoverState.optional(),
});

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
  cover: CoverValue,
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
export type CoverValue = z.infer<typeof CoverValue>;
