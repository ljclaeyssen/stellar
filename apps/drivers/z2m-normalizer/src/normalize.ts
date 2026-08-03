import { valueSchemas, type Kind } from '@stellar/contracts';
import {
  fieldName,
  fieldScale,
  isComposed,
  type DeviceMapping,
  type EntityMapping,
  type FieldRef,
} from './mapping-table.js';

/** Ce qu'un message Z2M produit : de quoi fabriquer une `Entity` du bus. */
export interface Percept {
  entityId: string;
  kind: Kind;
  room?: string;
  unit?: string;
  value: unknown;
}

/** Entité non publiée faute de champs — cas **nominal** : les payloads Z2M sont partiels. */
export interface SkippedEntity {
  entityId: string;
  missing: string[];
}

/** Entité refusée par le contrat du kind — anomalie : ça se logge en warn. */
export interface RejectedEntity {
  entityId: string;
  reason: string;
  value: unknown;
}

export interface NormalizeOutcome {
  percepts: Percept[];
  skipped: SkippedEntity[];
  rejected: RejectedEntity[];
}

type Extraction =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly value: unknown }
  | { readonly status: 'error'; readonly reason: string };

function extract(payload: Record<string, unknown>, ref: FieldRef): Extraction {
  const name = fieldName(ref);
  if (!Object.hasOwn(payload, name)) return { status: 'missing' };
  const raw = payload[name];
  // `null` = attribut effacé côté Z2M : rien à publier, pas une erreur.
  if (raw === null || raw === undefined) return { status: 'missing' };

  const scale = fieldScale(ref);
  if (scale === undefined) return { status: 'ok', value: raw };
  if (typeof raw !== 'number') {
    return { status: 'error', reason: `champ « ${name} » non numérique : scale inapplicable` };
  }
  return { status: 'ok', value: raw * scale };
}

function normalizeEntity(mapping: EntityMapping, payload: Record<string, unknown>): Extraction {
  if (!isComposed(mapping)) return extract(payload, mapping.field);

  // Composé : tout ou rien (cf. commentaire de `ComposedEntityMapping`).
  const value: Record<string, unknown> = {};
  for (const [target, ref] of Object.entries(mapping.fields)) {
    const extracted = extract(payload, ref);
    if (extracted.status !== 'ok') return extracted;
    value[target] = extracted.value;
  }
  return { status: 'ok', value };
}

/** Les champs déclarés par une entité, pour un log de skip qui dit quoi ajouter. */
function declaredFields(mapping: EntityMapping): string[] {
  return isComposed(mapping)
    ? Object.values(mapping.fields).map(fieldName)
    : [fieldName(mapping.field)];
}

/**
 * Traduction pure d'un message `zigbee2mqtt/<friendly_name>` en percepts.
 *
 * Trois issues par entité déclarée, et une seule est une anomalie :
 * - **champ absent** → l'entité est simplement absente de ce message (Z2M ne
 *   republie que ce qu'il a reçu). Silencieux.
 * - **valeur hors contrat** (sonde qui déraille, unité inattendue) → rejetée,
 *   loggée : l'ancien état retained reste en place, ce qui vaut mieux qu'une
 *   aberration publiée (règle n°4 de la spec : message invalide → jeté et loggé).
 * - **valeur conforme** → percept.
 *
 * Aucune interprétation ici : ni moyenne, ni seuil, ni mémoire. Le driver traduit.
 */
export function normalizeDevice(
  device: DeviceMapping,
  payload: Record<string, unknown>,
): NormalizeOutcome {
  const outcome: NormalizeOutcome = { percepts: [], skipped: [], rejected: [] };
  const room = device.room ?? undefined;

  for (const mapping of device.entities) {
    const result = normalizeEntity(mapping, payload);
    if (result.status === 'missing') {
      outcome.skipped.push({
        entityId: mapping.entityId,
        missing: declaredFields(mapping).filter((name) => !Object.hasOwn(payload, name)),
      });
      continue;
    }
    if (result.status === 'error') {
      outcome.rejected.push({
        entityId: mapping.entityId,
        reason: result.reason,
        value: undefined,
      });
      continue;
    }

    const parsed = valueSchemas[mapping.kind].safeParse(result.value);
    if (!parsed.success) {
      outcome.rejected.push({
        entityId: mapping.entityId,
        reason: parsed.error.issues.map((issue) => issue.message).join('; '),
        value: result.value,
      });
      continue;
    }

    outcome.percepts.push({
      entityId: mapping.entityId,
      kind: mapping.kind,
      ...(room === undefined ? {} : { room }),
      ...(mapping.unit === undefined ? {} : { unit: mapping.unit }),
      value: parsed.data,
    });
  }

  return outcome;
}
