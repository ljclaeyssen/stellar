import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Kind, type EntityDecl, type Manifest } from '@stellar/contracts';

/**
 * Table de mapping déclarative Zigbee2MQTT → contrats Stellar (spec §9, §13).
 *
 * Règle d'or : **un nouvel objet Zigbee = une ligne dans le fichier, zéro code.**
 * D'où une table volontairement bête — elle nomme des champs, elle ne calcule
 * pas. La seule transformation admise est un facteur d'échelle (`scale`), pour
 * les cas d'unité (Wh → kWh) ; tout le reste (moyennes, seuils, hystérésis)
 * relève du core, jamais d'un driver (interdit n°1).
 *
 * Les schémas sont `strict()` sur les devices et les entités : une faute de
 * frappe (`feild`, `entityid`) doit faire échouer le démarrage, pas produire
 * silencieusement un parc incomplet. Seule la racine est `passthrough()`, pour
 * y laisser un `_note` de documentation.
 */

/**
 * Référence à un champ du payload Z2M : son nom, éventuellement assorti d'un
 * facteur d'échelle. Une seule forme pour les entités scalaires **et** pour les
 * champs d'une entité composée — il n'y a qu'un concept à apprendre.
 */
export const FieldRef = z.union([
  z.string().min(1),
  z.object({ field: z.string().min(1), scale: z.number().finite() }).strict(),
]);
export type FieldRef = z.infer<typeof FieldRef>;

export const fieldName = (ref: FieldRef): string => (typeof ref === 'string' ? ref : ref.field);
export const fieldScale = (ref: FieldRef): number | undefined =>
  typeof ref === 'string' ? undefined : ref.scale;

const EntityCommon = {
  entityId: z.string().min(1),
  kind: Kind,
  unit: z.string().optional(),
};

/** Une valeur scalaire du payload devient directement le `value` de l'entité. */
export const ScalarEntityMapping = z.object({ ...EntityCommon, field: FieldRef }).strict();
export type ScalarEntityMapping = z.infer<typeof ScalarEntityMapping>;

/**
 * Plusieurs champs du payload composent le `value` de l'entité (ZLinky :
 * `{ va, indexBase }`). Publication **tout ou rien** : un objet composé
 * n'a de sens que complet, et le contrat du kind exige ses clés obligatoires.
 * Pour publier moins, déclarer moins.
 */
export const ComposedEntityMapping = z
  .object({
    ...EntityCommon,
    fields: z.record(FieldRef).refine((f) => Object.keys(f).length > 0, 'fields ne peut être vide'),
  })
  .strict();
export type ComposedEntityMapping = z.infer<typeof ComposedEntityMapping>;

export const EntityMapping = z.union([ScalarEntityMapping, ComposedEntityMapping]);
export type EntityMapping = z.infer<typeof EntityMapping>;

export const isComposed = (entity: EntityMapping): entity is ComposedEntityMapping =>
  'fields' in entity;

export const DeviceMapping = z
  .object({
    /** `friendly_name` tel que configuré dans Zigbee2MQTT — la clé de jointure. */
    friendlyName: z.string().min(1),
    /** Informatif : aide l'humain à recaler la table sur le matériel réel. */
    model: z.string().optional(),
    /** `null` accepté (ZLinky : pas de pièce) et traité comme absent. */
    room: z.string().min(1).nullish(),
    entities: z.array(EntityMapping).min(1),
  })
  .strict();
export type DeviceMapping = z.infer<typeof DeviceMapping>;

export const MappingTable = z
  .object({ devices: z.array(DeviceMapping) })
  .passthrough()
  .describe('config/z2m-mapping.json');
export type MappingTable = z.infer<typeof MappingTable>;

export interface MappingIndex {
  readonly table: MappingTable;
  /** Jointure `zigbee2mqtt/<friendly_name>` → device. */
  readonly byFriendlyName: ReadonlyMap<string, DeviceMapping>;
  readonly entityIds: readonly string[];
}

/**
 * Valide les invariants que zod ne peut pas voir champ par champ : deux devices
 * ne peuvent pas partager un `friendlyName`, deux entités un `entityId`. Ces
 * collisions produiraient des états qui s'écrasent l'un l'autre sur le bus —
 * on échoue au démarrage, bruyamment.
 */
export function indexMappingTable(input: unknown): MappingIndex {
  const table = MappingTable.parse(input);
  const byFriendlyName = new Map<string, DeviceMapping>();
  const entityIds: string[] = [];
  const seenEntityIds = new Set<string>();

  for (const device of table.devices) {
    if (byFriendlyName.has(device.friendlyName)) {
      throw new Error(`table de mapping : friendlyName en double « ${device.friendlyName} »`);
    }
    byFriendlyName.set(device.friendlyName, device);
    for (const entity of device.entities) {
      if (seenEntityIds.has(entity.entityId)) {
        throw new Error(
          `table de mapping : entityId en double « ${entity.entityId} » (device ${device.friendlyName})`,
        );
      }
      seenEntityIds.add(entity.entityId);
      entityIds.push(entity.entityId);
    }
  }

  return { table, byFriendlyName, entityIds };
}

export async function loadMappingTable(file: string): Promise<MappingIndex> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(
      `table de mapping introuvable (${file}) — c'est le fichier qui déclare le parc Zigbee : ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `table de mapping illisible (${file}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return indexMappingTable(parsed);
}

/**
 * Manifeste discovery **dérivé de la table** : ce que le driver déclare savoir
 * publier, avant même qu'un capteur ait parlé. Aucune commande — le parc Zigbee
 * de la P5 n'est fait que de capteurs (spec §16). Le jour où un objet pilotable
 * arrive (volet, prise), il apporte ses actions ; la table, elle, ne change pas
 * de forme.
 */
export function buildManifest(index: MappingIndex, driver: string, version: string): Manifest {
  const entities: EntityDecl[] = [];
  for (const device of index.table.devices) {
    for (const entity of device.entities) {
      entities.push({
        id: entity.entityId,
        kind: entity.kind,
        ...(device.room === null || device.room === undefined ? {} : { room: device.room }),
        ...(entity.unit === undefined ? {} : { unit: entity.unit }),
      });
    }
  }
  return { driver, version, entities, commands: [] };
}
