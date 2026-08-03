import type { z } from 'zod';
import type { Entity } from './entity.js';
import type { Kind } from './kind.js';
import { valueSchemas } from './values.js';

/** Le type du `value` associé à un `kind` (dérivé des schémas, jamais dupliqué à la main). */
export type ValueOf<K extends Kind> = z.infer<(typeof valueSchemas)[K]>;

/** Une `Entity` dont le `kind` est connu — et donc le `value` typé. */
export type EntityOf<K extends Kind> = Entity & { kind: K; value: ValueOf<K> };

/**
 * Guard typé : vrai si l'entité est du `kind` demandé ET que son `value` respecte
 * le schéma de ce kind. Après un `isKind(e, 'climate')`, `e.value.targetTemp` est
 * typé sans cast — c'est l'outil à utiliser côté core plutôt qu'un `as`.
 */
export function isKind<K extends Kind>(entity: Entity, kind: K): entity is EntityOf<K> {
  if (entity.kind !== kind) return false;
  return valueSchemas[kind].safeParse(entity.value).success;
}

/**
 * Parse le `value` d'une entité selon le schéma du `kind` demandé.
 * Retourne `undefined` si le kind ne correspond pas ou si le value est invalide.
 */
export function valueOf<K extends Kind>(entity: Entity, kind: K): ValueOf<K> | undefined {
  if (entity.kind !== kind) return undefined;
  const result = valueSchemas[kind].safeParse(entity.value);
  return result.success ? (result.data as ValueOf<K>) : undefined;
}
