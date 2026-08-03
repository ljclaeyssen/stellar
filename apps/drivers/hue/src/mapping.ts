import type { Logger } from '@stellar/bus';
import type { LightValue, PlugValue } from '@stellar/contracts';
import type { HueDevice, HueLight, HueResourceUpdate, HueRoom } from './clipv2.js';

/** Les deux seuls kinds exposés par le bridge (spec §9 hue-driver). */
export type HueEntityKind = 'light' | 'plug';
export type HueEntityValue = LightValue | PlugValue;

export interface HueEntity {
  /** entityId du bus : `light_<room>_<nom>` ou `plug_<nom>` (spec §6). */
  entityId: string;
  kind: HueEntityKind;
  room?: string;
  /** id de la ressource `light` CLIP v2 — cible des PUT et clé des événements SSE. */
  lightId: string;
  /** Nom tel qu'affiché dans l'app Hue — utile aux logs et au `verify`. */
  name: string;
  value: HueEntityValue;
}

/**
 * snake_case sans accents : `Chambre bébé` → `chambre_bebe`.
 * Décomposition NFD puis suppression des diacritiques, tout le reste devient `_`.
 */
export function slug(input: string): string {
  const out = input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out === '' ? 'sans_nom' : out;
}

const clampBrightness = (value: number): number => Math.min(100, Math.max(0, value));

/** État CLIP v2 d'une lampe → `value` du contrat, selon son kind. */
export function toValue(light: HueLight, kind: HueEntityKind): HueEntityValue {
  if (kind === 'plug') return { on: light.on.on };
  const value: LightValue = { on: light.on.on };
  if (light.dimming) value.brightness = clampBrightness(light.dimming.brightness);
  const color: Record<string, unknown> = {};
  if (light.color) color['xy'] = { x: light.color.xy.x, y: light.color.xy.y };
  // `mirek: null` = la lampe n'est pas en mode blanc réglable : on n'invente rien.
  if (light.color_temperature && light.color_temperature.mirek !== null) {
    color['mirek'] = light.color_temperature.mirek;
  }
  if (Object.keys(color).length > 0) value.color = color;
  return value;
}

/**
 * Applique un événement SSE (état *partiel*) sur la dernière valeur connue.
 * Retourne une nouvelle valeur : jamais de mutation en place, l'entité publiée
 * et l'entité mémorisée ne doivent pas partager de référence.
 */
export function mergeUpdate(
  current: HueEntityValue,
  update: HueResourceUpdate,
  kind: HueEntityKind,
): HueEntityValue {
  if (kind === 'plug') return { on: update.on?.on ?? current.on };

  const previous = current as LightValue;
  const next: LightValue = { on: update.on?.on ?? previous.on };
  const brightness = update.dimming
    ? clampBrightness(update.dimming.brightness)
    : previous.brightness;
  if (brightness !== undefined) next.brightness = brightness;

  const color: Record<string, unknown> = { ...previous.color };
  if (update.color) color['xy'] = { x: update.color.xy.x, y: update.color.xy.y };
  if (update.color_temperature) {
    if (update.color_temperature.mirek === null) delete color['mirek'];
    else color['mirek'] = update.color_temperature.mirek;
  }
  if (Object.keys(color).length > 0) next.color = color;
  return next;
}

export interface InventoryInput {
  lights: HueLight[];
  devices: HueDevice[];
  rooms: HueRoom[];
  logger: Logger;
}

/**
 * Inventaire CLIP v2 → entités du bus. Traduction pure : aucune décision, aucune
 * connaissance du reste du système (interdit n°1 de la spec).
 *
 * La room d'une lampe est celle dont les `children` contiennent le **device
 * propriétaire** de la lampe (`owner.rid`) — CLIP v2 range les devices, pas les
 * services.
 */
export function buildInventory(input: InventoryInput): HueEntity[] {
  const { lights, devices, rooms, logger } = input;

  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const roomByDeviceId = new Map<string, string>();
  for (const room of rooms) {
    for (const child of room.children) {
      if (child.rtype !== 'device') continue;
      roomByDeviceId.set(child.rid, room.metadata.name);
    }
  }

  const taken = new Set<string>();
  const entities: HueEntity[] = [];

  for (const light of lights) {
    const device = deviceById.get(light.owner.rid);
    // L'archetype vit sur le service ; certains firmwares ne le posent que sur le
    // device propriétaire — d'où le repli, sans quoi une prise sortirait en `light`.
    const archetype = light.metadata.archetype ?? device?.metadata.archetype;
    const kind: HueEntityKind = archetype === 'plug' ? 'plug' : 'light';
    const roomName = roomByDeviceId.get(light.owner.rid);
    const nameSlug = slug(light.metadata.name);

    const base =
      kind === 'plug'
        ? `plug_${nameSlug}`
        : roomName === undefined
          ? `light_${nameSlug}`
          : `light_${slug(roomName)}_${nameSlug}`;

    let entityId = base;
    let suffix = 1;
    while (taken.has(entityId)) {
      suffix += 1;
      entityId = `${base}_${suffix}`;
    }
    if (entityId !== base) {
      logger.warn('collision d’entityId, suffixe ajouté', {
        base,
        entityId,
        lightId: light.id,
        name: light.metadata.name,
      });
    }
    taken.add(entityId);

    entities.push({
      entityId,
      kind,
      ...(roomName === undefined ? {} : { room: slug(roomName) }),
      lightId: light.id,
      name: light.metadata.name,
      value: toValue(light, kind),
    });
  }

  return entities;
}
