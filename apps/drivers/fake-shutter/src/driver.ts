import { z } from 'zod';
import type { Bus, Logger } from '@stellar/bus';
import {
  toJsonSchema,
  type Ack,
  type Command,
  type CoverState,
  type CoverValue,
  type Entity,
  type Manifest,
} from '@stellar/contracts';

/**
 * Driver de volet **simulé** — le test d'acceptance d'extensibilité de la spec §13
 * (« brancher à chaud un fake-shutter-driver → il apparaît dans les capacités et se
 * pilote, sans qu'aucun commit n'ait touché core/agent »).
 *
 * Ce n'est pas un mock de test : c'est un driver complet et ordinaire, avec son
 * process, son manifeste retained, son LWT et sa traduction de commandes. Sa seule
 * particularité est que le « matériel » est une variable en mémoire — ce qui en
 * fait aussi le volet de démonstration du banc d'essai (`scripts/bench.mjs`) tant
 * qu'aucun volet Zigbee n'est branché.
 *
 * Zéro logique métier (interdit n°1) : il ne décide ni quand ouvrir, ni pourquoi.
 * Il traduit une intention en mouvement et publie ce qu'il observe.
 */

export const DRIVER_NAME = 'fake-shutter';
export const DRIVER_VERSION = '0.1.0';

/** Bornes de course, dans le vocabulaire du contrat (`CoverValue` : 0 fermé, 100 ouvert). */
export const POSITION_CLOSED = 0;
export const POSITION_OPEN = 100;

/** Course parcourue à chaque pas de simulation. */
export const STEP_PERCENT = 5;
/** Défaut aligné sur `DriverConfig.speedMs`. */
export const DEFAULT_SPEED_MS = 200;

/**
 * Paramètres du `set`. `.strict()` : une clé inventée est un refus, jamais un
 * silence — un appelant qui écrit `positon: 30` doit l'apprendre tout de suite.
 * `position` et `action` s'excluent : un `{position: 0, action: 'open'}` n'a pas
 * de sens, et le résoudre « au mieux » serait une décision (interdit n°1).
 */
export const SetParams = z
  .object({
    /** % d'ouverture visé — 0 fermé, 100 ouvert. */
    position: z.number().min(POSITION_CLOSED).max(POSITION_OPEN).optional(),
    action: z.enum(['open', 'close', 'stop']).optional(),
  })
  .strict()
  .refine(
    (params) => (params.position === undefined) !== (params.action === undefined),
    'exactement un de position | action est attendu',
  );
export type SetParams = z.infer<typeof SetParams>;

export interface FakeShutterOptions {
  bus: Bus;
  entityId: string;
  room: string;
  logger: Logger;
  /** Défaut `DEFAULT_SPEED_MS` — délai entre deux pas de `STEP_PERCENT` %. */
  speedMs?: number;
}

/** Ce que le driver expose à son appelant (et aux tests) une fois démarré. */
export interface FakeShutterHandle {
  readonly position: number;
  readonly state: CoverState;
  /** Arrête la simulation (le bus, lui, appartient à l'appelant). */
  close(): void;
}

export function buildManifest(entityId: string, room: string): Manifest {
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities: [{ id: entityId, kind: 'cover', room, unit: '%' }],
    commands: [{ action: 'set', paramsSchema: toJsonSchema(SetParams) }],
  };
}

export async function startFakeShutterDriver(
  options: FakeShutterOptions,
): Promise<FakeShutterHandle> {
  const { bus, entityId, room, logger } = options;
  const speedMs = options.speedMs ?? DEFAULT_SPEED_MS;

  // Le volet démarre ouvert : c'est l'état d'un volet qu'on vient d'alimenter, et
  // ça évite qu'un redémarrage du driver ne prétende avoir fermé la maison.
  let position = POSITION_OPEN;
  let state: CoverState = 'open';
  let target = position;
  let timer: NodeJS.Timeout | undefined;

  /** État d'un volet **à l'arrêt** : la position seule le décrit (cf. `CoverValue`). */
  const restState = (): CoverState => {
    if (position <= POSITION_CLOSED) return 'closed';
    if (position >= POSITION_OPEN) return 'open';
    return 'stopped';
  };

  const publish = async (): Promise<void> => {
    const value: CoverValue = { position, state };
    const entity: Entity = {
      id: entityId,
      driver: DRIVER_NAME,
      kind: 'cover',
      room,
      value,
      unit: '%',
      ts: new Date().toISOString(),
    };
    await bus.publishState(entity);
  };
  /** Une publication ratée ne doit jamais tuer le driver ni rester silencieuse. */
  const publishSafe = (): void => {
    void publish().catch((err: unknown) =>
      logger.warn('publication state échouée', { error: String(err) }),
    );
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  /** Fin de mouvement (arrivée ou `stop`) : le volet se pose là où il est. */
  const settle = (): void => {
    stopTimer();
    target = position;
    state = restState();
    publishSafe();
  };

  const step = (): void => {
    const delta = Math.min(STEP_PERCENT, Math.abs(target - position));
    position = target > position ? position + delta : position - delta;
    if (position === target) {
      settle();
      return;
    }
    // Chaque pas est publié : c'est ce qui rend le mouvement visible sur le bus
    // (et donc dans HA et dans le journal), comme le ferait un vrai moteur.
    publishSafe();
  };

  const moveTo = (wanted: number): void => {
    target = Math.min(POSITION_OPEN, Math.max(POSITION_CLOSED, wanted));
    if (target === position) {
      settle();
      return;
    }
    state = target > position ? 'opening' : 'closing';
    publishSafe();
    stopTimer();
    timer = setInterval(step, speedMs);
    // Le volet ne doit pas maintenir le process en vie à lui seul : c'est la
    // connexion au bus qui décide de la durée de vie du driver.
    timer.unref();
  };

  await bus.onCommand((cmd: Command): Ack => {
    const ok: Ack = { commandId: cmd.id, status: 'ok' };
    const rejected = (reason: string): Ack => ({ commandId: cmd.id, status: 'rejected', reason });

    if (cmd.target !== entityId) return rejected(`entité inconnue: ${cmd.target}`);
    if (cmd.action !== 'set') return rejected(`action inconnue: ${cmd.action}`);

    const params = SetParams.safeParse(cmd.params);
    if (!params.success) return rejected(params.error.message);

    const { position: wanted, action } = params.data;
    if (wanted !== undefined) {
      moveTo(wanted);
      return ok;
    }
    switch (action) {
      case 'open':
        moveTo(POSITION_OPEN);
        return ok;
      case 'close':
        moveTo(POSITION_CLOSED);
        return ok;
      case 'stop':
        settle();
        return ok;
      default:
        return rejected('exactement un de position | action est attendu');
    }
  });

  await bus.announce(buildManifest(entityId, room));
  // L'entité doit exister sur le bus dès le démarrage : c'est elle que le core
  // découvre, pas le manifeste seul.
  publishSafe();
  logger.info('driver fake-shutter prêt', { entityId, room, speedMs });

  return {
    get position() {
      return position;
    },
    get state() {
      return state;
    },
    close() {
      stopTimer();
    },
  };
}
