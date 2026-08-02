import { z } from 'zod';
import { Kind } from './kind.js';
import type { Entity } from './entity.js';

/**
 * Règle n°7 de la spec : core et agent n'adressent JAMAIS un driver par son nom
 * dans leur logique — uniquement kind + room. `driver`/`id` existent pour
 * l'outillage (cli, debug) et le routage bas niveau.
 */
export const Selector = z.object({
  kind: Kind.optional(),
  room: z.string().optional(),
  driver: z.string().optional(),
  id: z.string().optional(),
});
export type Selector = z.infer<typeof Selector>;

export function matchesSelector(entity: Entity, selector: Selector): boolean {
  if (selector.kind !== undefined && entity.kind !== selector.kind) return false;
  if (selector.room !== undefined && entity.room !== selector.room) return false;
  if (selector.driver !== undefined && entity.driver !== selector.driver) return false;
  if (selector.id !== undefined && entity.id !== selector.id) return false;
  return true;
}
