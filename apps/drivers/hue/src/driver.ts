import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import {
  toJsonSchema,
  type Ack,
  type Command,
  type Entity,
  type EntityDecl,
  type Manifest,
} from '@stellar/contracts';
import type { HueApiLike, HueEventStream } from './api.js';
import type { HueLightPatch } from './clipv2.js';
import { buildInventory, mergeUpdate, type HueEntity } from './mapping.js';

export const DRIVER_NAME = 'hue';
export const DRIVER_VERSION = '0.1.0';

/** ADR-009 : jamais d'ack `ok` pour une commande qu'on sait ne pas pouvoir transmettre. */
const UNREACHABLE = 'bridge injoignable';

/**
 * Paramètres de `set`. Bornes = celles de CLIP v2 (brightness %, xy CIE,
 * mirek 153–500) : le driver refuse ce que le bridge refuserait, sans décider
 * de rien d'autre.
 */
export const SetParams = z
  .object({
    on: z.boolean().optional(),
    brightness: z.number().min(0).max(100).optional(),
    color: z
      .object({
        xy: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
        mirek: z.number().int().min(153).max(500).optional(),
      })
      .refine(
        (color) => color.xy !== undefined || color.mirek !== undefined,
        'color doit porter xy ou mirek',
      )
      .optional(),
  })
  .strict()
  .refine(
    (params) => params.on !== undefined || params.brightness !== undefined || params.color,
    'au moins un de on, brightness, color est requis',
  );
export type SetParams = z.infer<typeof SetParams>;

export interface HueDriverOptions {
  bus: Bus;
  api: HueApiLike;
  logger: Logger;
}

export interface HueDriverHandle {
  /** Bridge joignable : faux dès la perte du flux SSE (ADR-009). */
  readonly reachable: boolean;
  readonly entities: readonly HueEntity[];
  /** Ré-inventaire complet + republication — exposé pour l'outillage et les tests. */
  resync(): Promise<void>;
  close(): void;
}

export function buildManifest(entities: readonly HueEntity[]): Manifest {
  const decls: EntityDecl[] = entities.map((entity) => ({
    id: entity.entityId,
    kind: entity.kind,
    ...(entity.room === undefined ? {} : { room: entity.room }),
  }));
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities: decls,
    commands: [{ action: 'set', paramsSchema: toJsonSchema(SetParams) }],
  };
}

/** Params du bus → corps du PUT CLIP v2. Traduction 1:1, rien de plus. */
export function toLightPatch(params: SetParams): HueLightPatch {
  const patch: HueLightPatch = {};
  if (params.on !== undefined) patch.on = { on: params.on };
  if (params.brightness !== undefined) patch.dimming = { brightness: params.brightness };
  if (params.color?.xy) patch.color = { xy: params.color.xy };
  if (params.color?.mirek !== undefined) patch.color_temperature = { mirek: params.color.mirek };
  return patch;
}

/**
 * Traducteur pur : inventaire CLIP v2 → entités retained, événements SSE →
 * republication, commandes du bus → PUT. Aucune décision ici (interdit n°1).
 *
 * Cycle de vie du lien bridge (ADR-009) : le flux SSE est la seule sonde. Sa
 * perte marque toutes les entités `stale: true` et fait rejeter les commandes ;
 * son retour déclenche un **ré-inventaire complet** — pendant la coupure des
 * lampes ont pu être ajoutées, renommées ou déplacées de pièce, et un état
 * partiel serait pire que pas d'état.
 */
export async function startHueDriver(options: HueDriverOptions): Promise<HueDriverHandle> {
  const { bus, api, logger } = options;

  let entities: HueEntity[] = [];
  let byEntityId = new Map<string, HueEntity>();
  let byLightId = new Map<string, HueEntity>();
  let reachable = false;
  let stream: HueEventStream | null = null;

  const toEntity = (entity: HueEntity, stale: boolean): Entity => ({
    id: entity.entityId,
    driver: DRIVER_NAME,
    kind: entity.kind,
    ...(entity.room === undefined ? {} : { room: entity.room }),
    value: { ...entity.value },
    ts: new Date().toISOString(),
    ...(stale ? { stale: true } : {}),
  });

  const publish = async (entity: HueEntity): Promise<void> => {
    await bus.publishState(toEntity(entity, !reachable));
  };
  /** Une publication ratée ne doit ni tuer le driver ni passer inaperçue. */
  const publishSafe = (entity: HueEntity): void => {
    void publish(entity).catch((err) =>
      logger.warn('publication state échouée', { entityId: entity.entityId, error: String(err) }),
    );
  };
  const publishAll = async (): Promise<void> => {
    await Promise.all(entities.map((entity) => publish(entity)));
  };

  const resync = async (): Promise<void> => {
    const [lights, devices, rooms] = await Promise.all([
      api.getLights(),
      api.getDevices(),
      api.getRooms(),
    ]);
    entities = buildInventory({ lights, devices, rooms, logger });
    byEntityId = new Map(entities.map((entity) => [entity.entityId, entity]));
    byLightId = new Map(entities.map((entity) => [entity.lightId, entity]));
    reachable = true;
    await publishAll();
    await bus.announce(buildManifest(entities));
    logger.info('inventaire publié', {
      entities: entities.length,
      plugs: entities.filter((entity) => entity.kind === 'plug').length,
      rooms: [...new Set(entities.map((entity) => entity.room).filter(Boolean))].length,
    });
  };

  const markUnreachable = (reason: string): void => {
    if (!reachable) return;
    reachable = false;
    logger.warn('bridge muet, entités marquées stale (ADR-009)', { reason });
    for (const entity of entities) publishSafe(entity);
  };

  await bus.onCommand(async (cmd: Command): Promise<Ack> => {
    const rejected = (reason: string): Ack => ({ commandId: cmd.id, status: 'rejected', reason });
    const entity = byEntityId.get(cmd.target);
    if (!entity) return rejected(`entité inconnue: ${cmd.target}`);
    if (cmd.action !== 'set') return rejected(`action inconnue: ${cmd.action}`);

    const params = SetParams.safeParse(cmd.params);
    if (!params.success) return rejected(params.error.issues.map((i) => i.message).join('; '));
    if (entity.kind === 'plug' && (params.data.brightness !== undefined || params.data.color)) {
      return rejected(`une prise ne gère que on: ${cmd.target}`);
    }
    if (!reachable) return rejected(UNREACHABLE);

    try {
      await api.setLight(entity.lightId, toLightPatch(params.data));
    } catch (err) {
      // Le bridge n'a pas confirmé : on ne prétend pas avoir transmis (ADR-009).
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('commande refusée par le bridge', { entityId: cmd.target, reason });
      return rejected(reason);
    }
    // Ack = accusé de *transmission* : le bridge a répondu 2xx. L'état, lui,
    // arrivera par le flux SSE (ce qui rend `stellar states` frais < 300 ms).
    return { commandId: cmd.id, status: 'ok' };
  });

  // Best effort : bridge éteint au démarrage ⇒ le driver vit quand même, et le
  // flux SSE (onUp) fera l'inventaire dès que le bridge répondra.
  try {
    await resync();
  } catch (err) {
    reachable = false;
    logger.error('inventaire initial impossible, attente du bridge', { error: String(err) });
    await bus.announce(buildManifest(entities));
  }

  stream = api.openEventStream(
    (updates) => {
      for (const update of updates) {
        const entity = byLightId.get(update.id);
        if (!entity) {
          logger.debug('événement pour une ressource hors inventaire', { lightId: update.id });
          continue;
        }
        entity.value = mergeUpdate(entity.value, update, entity.kind);
        publishSafe(entity);
      }
    },
    (reason) => markUnreachable(reason),
    () => {
      if (reachable) return;
      logger.info('bridge de nouveau joignable, ré-inventaire');
      void resync().catch((err) => logger.error('resync échoué', { error: String(err) }));
    },
  );

  logger.info('driver hue prêt', { entities: entities.length, reachable });

  return {
    get reachable() {
      return reachable;
    },
    get entities() {
      return entities;
    },
    resync,
    close() {
      stream?.close();
      stream = null;
    },
  };
}
