import { z } from 'zod';

/**
 * Contrats zod de la frontière HTTP avec le bridge (règle n°4 de la spec).
 *
 * Tous les objets sont en `.passthrough()` : le bridge ajoute des champs à
 * chaque firmware, les ignorer silencieusement vaut mieux que rejeter un
 * inventaire entier. À l'inverse, un champ *attendu* absent ou mal typé fait
 * échouer la ressource, qui est loggée et sautée (jamais de crash).
 */

const ResourceRef = z.object({ rid: z.string(), rtype: z.string() }).passthrough();

export const HueLight = z
  .object({
    id: z.string().min(1),
    owner: ResourceRef,
    metadata: z.object({ name: z.string().min(1), archetype: z.string().optional() }).passthrough(),
    on: z.object({ on: z.boolean() }).passthrough(),
    dimming: z.object({ brightness: z.number() }).passthrough().optional(),
    color: z
      .object({ xy: z.object({ x: z.number(), y: z.number() }).passthrough() })
      .passthrough()
      .optional(),
    color_temperature: z.object({ mirek: z.number().nullable() }).passthrough().optional(),
    type: z.string().optional(),
  })
  .passthrough();
export type HueLight = z.infer<typeof HueLight>;

export const HueDevice = z
  .object({
    id: z.string().min(1),
    metadata: z.object({ name: z.string().min(1), archetype: z.string().optional() }).passthrough(),
    product_data: z.object({ product_name: z.string().optional() }).passthrough().optional(),
    services: z.array(ResourceRef).default([]),
    type: z.string().optional(),
  })
  .passthrough();
export type HueDevice = z.infer<typeof HueDevice>;

export const HueRoom = z
  .object({
    id: z.string().min(1),
    children: z.array(ResourceRef).default([]),
    metadata: z.object({ name: z.string().min(1) }).passthrough(),
    type: z.string().optional(),
  })
  .passthrough();
export type HueRoom = z.infer<typeof HueRoom>;

/** Enveloppe commune `{errors, data}` — `data` reste brut, filtré ressource par ressource. */
export const HueEnvelope = z
  .object({
    errors: z.array(z.unknown()).default([]),
    data: z.array(z.unknown()).default([]),
  })
  .passthrough();

/** Un élément du tableau `data` d'un événement SSE (l'état partiel d'une ressource). */
export const HueResourceUpdate = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    on: z.object({ on: z.boolean() }).passthrough().optional(),
    dimming: z.object({ brightness: z.number() }).passthrough().optional(),
    color: z
      .object({ xy: z.object({ x: z.number(), y: z.number() }).passthrough() })
      .passthrough()
      .optional(),
    color_temperature: z.object({ mirek: z.number().nullable() }).passthrough().optional(),
  })
  .passthrough();
export type HueResourceUpdate = z.infer<typeof HueResourceUpdate>;

/** Un événement du flux SSE : `[{creationtime, id, type:'update', data:[…]}]`. */
export const HueEvent = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    creationtime: z.string().optional(),
    data: z.array(z.unknown()).default([]),
  })
  .passthrough();

/** Réponse de pairing `POST /api` — succès ou erreur, toujours dans un tableau. */
export const HuePairingResponse = z.array(
  z
    .object({
      success: z
        .object({ username: z.string().min(1), clientkey: z.string().optional() })
        .passthrough()
        .optional(),
      error: z
        .object({ type: z.number(), description: z.string(), address: z.string().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough(),
);

/** Corps d'un `PUT /clip/v2/resource/light/<id>` — partiel par construction. */
export interface HueLightPatch {
  on?: { on: boolean };
  dimming?: { brightness: number };
  color?: { xy: { x: number; y: number } };
  color_temperature?: { mirek: number };
}
