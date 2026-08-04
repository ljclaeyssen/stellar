import type { ClimateMode, Kind } from '@stellar/contracts';
import {
  HA_COMMAND_ROOT,
  HA_COVER_POSITION_CLOSED,
  HA_COVER_POSITION_OPEN,
  HA_FIELD,
} from './discovery.js';

/**
 * Traduction **commande HA → `Command` du bus** (P8, spec §10 et §12).
 *
 * C'est la voie des intents vocaux locaux : HA (ou un satellite Voice PE via
 * Assist) publie sur `home/ha/cmd/<entityId>[/<field>]`, ce module en fait des
 * `params` conformes au contrat du `kind`. Comme `discovery.ts`, il est pur —
 * l'envoi, la résolution du driver et l'acquittement sont l'affaire du pont.
 *
 * Deux règles qui ne se négocient pas :
 *
 * - **Aucune supposition.** Un payload qu'on ne sait pas traduire est refusé, pas
 *   « interprété au mieux ». Une commande vocale mal comprise vaut mieux ignorée
 *   qu'exécutée de travers.
 * - **Rien hors des kinds pilotables.** Un `lock` publié à la main sur ce canal
 *   ne produit aucune commande : le pont n'est pas une porte dérobée vers la
 *   sécurité (spec §4 n°1).
 */

/** Cible extraite d'un topic `home/ha/cmd/<entityId>[/<field>]`. */
export interface HaCommandTarget {
  entityId: string;
  /** `null` = topic principal (allumage). */
  field: string | null;
}

/** Ce que le pont enverra sur le bus — l'action est toujours `set` (contrat §7). */
export interface HaTranslatedCommand {
  action: 'set';
  params: Record<string, unknown>;
}

const ROOT_PARTS = HA_COMMAND_ROOT.split('/');

export function parseHaCommandTopic(topic: string): HaCommandTarget | null {
  const parts = topic.split('/');
  if (parts.length < ROOT_PARTS.length + 1 || parts.length > ROOT_PARTS.length + 2) return null;
  for (const [index, expected] of ROOT_PARTS.entries()) {
    if (parts[index] !== expected) return null;
  }
  const entityId = parts[ROOT_PARTS.length];
  if (entityId === undefined || entityId.length === 0) return null;
  const field = parts[ROOT_PARTS.length + 1] ?? null;
  if (field !== null && field.length === 0) return null;
  return { entityId, field };
}

/** Payloads JSON (cf. `discovery.ts`, parti pris n°3) : `true`, `42`, `"heat"`. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asBoolean(raw: string): boolean | undefined {
  const value = parseJson(raw);
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(raw: string, min: number, max: number): number | undefined {
  const value = parseJson(raw);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < min || value > max ? undefined : value;
}

/**
 * Vocabulaire HA → contrat `ClimateValue`. `off` n'est pas un mode chez nous
 * (c'est `power:false`), et notre `fan` s'appelle `fan_only` chez eux.
 */
const CLIMATE_MODES: Record<string, { power: boolean; mode?: ClimateMode }> = {
  off: { power: false },
  heat: { power: true, mode: 'heat' },
  cool: { power: true, mode: 'cool' },
  auto: { power: true, mode: 'auto' },
  dry: { power: true, mode: 'dry' },
  fan_only: { power: true, mode: 'fan' },
};

/**
 * Verbes d'un `cover` HA → `params` du contrat. Le driver reçoit une intention
 * (`open`), jamais une position déduite ici : c'est lui qui connaît la course
 * réelle de son volet.
 */
const COVER_ACTIONS: Record<string, 'open' | 'close' | 'stop'> = {
  open: 'open',
  close: 'close',
  stop: 'stop',
};

/** Bornes de plausibilité d'une consigne : au-delà, le payload est une erreur. */
const TARGET_TEMP_MIN = 5;
const TARGET_TEMP_MAX = 35;
/** `LightValue.brightness` est en % (contrat), et `brightness_scale: 100` le dit à HA. */
const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 100;

export function translateHaCommand(
  kind: Kind,
  field: string | null,
  raw: string,
): HaTranslatedCommand | null {
  if (kind === 'light') {
    if (field === null) {
      const on = asBoolean(raw);
      return on === undefined ? null : { action: 'set', params: { on } };
    }
    if (field === HA_FIELD.brightness) {
      const brightness = asNumber(raw, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
      return brightness === undefined
        ? null
        : { action: 'set', params: { brightness: Math.round(brightness) } };
    }
    return null;
  }

  if (kind === 'plug') {
    if (field !== null) return null;
    const on = asBoolean(raw);
    return on === undefined ? null : { action: 'set', params: { on } };
  }

  if (kind === 'climate') {
    if (field === HA_FIELD.mode) {
      const value = parseJson(raw);
      if (typeof value !== 'string') return null;
      const mapped = CLIMATE_MODES[value];
      if (mapped === undefined) return null;
      return {
        action: 'set',
        params: {
          power: mapped.power,
          ...(mapped.mode !== undefined ? { mode: mapped.mode } : {}),
        },
      };
    }
    if (field === HA_FIELD.temperature) {
      const targetTemp = asNumber(raw, TARGET_TEMP_MIN, TARGET_TEMP_MAX);
      return targetTemp === undefined ? null : { action: 'set', params: { targetTemp } };
    }
    return null;
  }

  if (kind === 'cover') {
    if (field === null) {
      const value = parseJson(raw);
      if (typeof value !== 'string') return null;
      const action = COVER_ACTIONS[value];
      return action === undefined ? null : { action: 'set', params: { action } };
    }
    if (field === HA_FIELD.position) {
      const position = asNumber(raw, HA_COVER_POSITION_CLOSED, HA_COVER_POSITION_OPEN);
      return position === undefined
        ? null
        : { action: 'set', params: { position: Math.round(position) } };
    }
    return null;
  }

  // Capteurs (temperature, humidity, presence, power, media, tempo, weather) : en
  // lecture seule. Kinds réservés et `lock` : jamais, quelle que soit la source.
  return null;
}
