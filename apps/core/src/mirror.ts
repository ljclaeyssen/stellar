import type { Bus, Logger } from '@stellar/bus';
import { Health, Manifest, matchesSelector, type Entity, type Selector } from '@stellar/contracts';

/**
 * Miroir d'état minimal (P1, spec §10) : souscrit `home/#`, garde le dernier
 * état de chaque entité en mémoire, accès uniquement par sélecteurs.
 * Journal SQLite, détection stale et API tRPC arrivent en P5.
 */
export interface Mirror {
  getStates(selector?: Selector): Entity[];
  getState(id: string): Entity | undefined;
  /** driver → santé — la clé est le nom du driver tel que publié sur home/health/<driver> */
  getHealth(): ReadonlyMap<string, Health>;
  /** driver → manifeste discovery (agrégat pour le futur list_capabilities) */
  getManifests(): ReadonlyMap<string, Manifest>;
}

export interface MirrorOptions {
  bus: Bus;
  logger: Logger;
  /** notifié à chaque mise à jour d'entité (log, futur journal) */
  onChange?: (entity: Entity) => void;
}

export async function createMirror(options: MirrorOptions): Promise<Mirror> {
  const { bus, logger, onChange } = options;
  const entities = new Map<string, Entity>();
  const health = new Map<string, Health>();
  const manifests = new Map<string, Manifest>();

  await bus.onState({}, (entity) => {
    entities.set(entity.id, entity);
    onChange?.(entity);
  });

  // health + discovery ne passent pas par onState : abonnements bruts + validation zod.
  bus.client.on('message', (topic, payload) => {
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[0] !== 'home') return;
    const [, channel, driver] = parts;
    if (driver === undefined) return;
    try {
      handleInfra(channel, driver, payload.toString());
    } catch {
      logger.warn('payload illisible, jeté', { topic });
    }
  });
  const handleInfra = (channel: string | undefined, driver: string, raw: string): void => {
    if (channel === 'health') {
      const parsed = Health.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('health invalide, jeté', { driver });
        return;
      }
      health.set(driver, parsed.data);
    } else if (channel === 'discovery') {
      const parsed = Manifest.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('manifeste invalide, jeté', { driver });
        return;
      }
      manifests.set(driver, parsed.data);
    }
  };
  await bus.client.subscribeAsync(['home/health/+', 'home/discovery/+'], { qos: 1 });

  return {
    getStates(selector = {}) {
      return [...entities.values()].filter((entity) => matchesSelector(entity, selector));
    },
    getState(id) {
      return entities.get(id);
    },
    getHealth() {
      return health;
    },
    getManifests() {
      return manifests;
    },
  };
}
