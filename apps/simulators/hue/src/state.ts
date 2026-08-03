import { readFileSync } from 'node:fs';

/**
 * L'état du simulateur EST le payload CLIP v2 : on stocke les ressources telles
 * que le bridge les renvoie (`Record<string, unknown>`), pas un modèle réduit.
 * Recaler une fixture sur le bridge réel recale donc le simulateur sans code.
 */
export type HueResource = Record<string, unknown> & { id: string };

export interface SimState {
  lights: HueResource[];
  devices: HueResource[];
  rooms: HueResource[];
}

/** Patch accepté par `PUT /clip/v2/resource/light/<id>` et par `setLight()`. */
export interface SimLightPatch {
  on?: { on: boolean };
  dimming?: { brightness: number };
  color?: { xy: { x: number; y: number } };
  color_temperature?: { mirek: number | null };
}

/**
 * Descripteur de haut niveau pour composer un état sur mesure (tests) sans
 * écrire à la main les trois ressources CLIP v2 corrélées.
 */
export interface SimLight {
  /** id de la ressource `light` — généré si absent. */
  id?: string;
  /** id du `device` propriétaire — généré si absent. */
  deviceId?: string;
  name: string;
  /** Nom de la room ; absent ⇒ la lampe n'appartient à aucune room. */
  room?: string;
  /** `plug` pour une prise connectée (cf. mapping du driver). */
  archetype?: string;
  on?: boolean;
  brightness?: number;
  xy?: { x: number; y: number };
  mirek?: number | null;
}

const FIXTURES = new URL('../../../drivers/hue/__fixtures__/clipv2/', import.meta.url);

function readResources(file: string): HueResource[] {
  const url = new URL(file, FIXTURES);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    throw new Error(
      `fixture CLIP v2 illisible (${url.pathname}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = isRecord(raw) ? raw['data'] : undefined;
  if (!Array.isArray(data)) throw new Error(`fixture CLIP v2 sans tableau 'data' : ${file}`);
  return data.map((item, index) => {
    if (!isRecord(item) || typeof item['id'] !== 'string') {
      throw new Error(`fixture CLIP v2 ${file}: ressource #${index} sans id`);
    }
    return item as HueResource;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * État par défaut : les fixtures `apps/drivers/hue/__fixtures__/clipv2/*.json`
 * (2 lampes + 1 prise « Prise TV », rooms salon/chambre). Relu à chaque appel —
 * chaque simulateur possède donc son propre état mutable.
 */
export function loadFixtureState(): SimState {
  return {
    lights: readResources('lights.json'),
    devices: readResources('devices.json'),
    rooms: readResources('rooms.json'),
  };
}

/** Construit les ressources CLIP v2 corrélées (light + device + room) depuis des descripteurs. */
export function buildState(lights: SimLight[]): SimState {
  const state: SimState = { lights: [], devices: [], rooms: [] };
  const roomsByName = new Map<string, HueResource>();

  lights.forEach((light, index) => {
    const lightId = light.id ?? `sim-light-${index + 1}`;
    const deviceId = light.deviceId ?? `sim-device-${index + 1}`;
    const archetype = light.archetype ?? 'sultan_bulb';

    const resource: HueResource = {
      id: lightId,
      owner: { rid: deviceId, rtype: 'device' },
      metadata: { name: light.name, archetype },
      on: { on: light.on ?? false },
      mode: 'normal',
      type: 'light',
    };
    if (light.brightness !== undefined) resource['dimming'] = { brightness: light.brightness };
    if (light.xy !== undefined) resource['color'] = { xy: light.xy, gamut_type: 'C' };
    if (light.mirek !== undefined) {
      resource['color_temperature'] = { mirek: light.mirek, mirek_valid: light.mirek !== null };
    }
    state.lights.push(resource);

    state.devices.push({
      id: deviceId,
      metadata: { name: light.name, archetype },
      product_data: { product_name: archetype === 'plug' ? 'Hue smart plug' : 'Hue lamp' },
      services: [{ rid: lightId, rtype: 'light' }],
      type: 'device',
    });

    if (light.room === undefined) return;
    let room = roomsByName.get(light.room);
    if (!room) {
      room = {
        id: `sim-room-${roomsByName.size + 1}`,
        children: [],
        metadata: { name: light.room, archetype: 'other' },
        type: 'room',
      };
      roomsByName.set(light.room, room);
      state.rooms.push(room);
    }
    (room['children'] as Array<{ rid: string; rtype: string }>).push({
      rid: deviceId,
      rtype: 'device',
    });
  });

  return state;
}

/**
 * Fusion récursive du patch dans la ressource (comme le bridge : un
 * `{dimming:{brightness}}` ne fait pas disparaître `min_dim_level`).
 */
export function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isRecord(value) && isRecord(current)) mergeInto(current, value);
    else target[key] = value;
  }
}
