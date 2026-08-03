import type { Bus, Logger } from '@stellar/bus';
import { Health, Manifest, matchesSelector, type Entity, type Selector } from '@stellar/contracts';

/**
 * Miroir d'état minimal (P1, spec §10) : souscrit `home/#`, garde le dernier
 * état de chaque entité en mémoire, accès uniquement par sélecteurs.
 * Journal SQLite, détection stale et API tRPC arrivent en P5.
 */
export interface Mirror {
  getStates(selector?: Selector): Entity[];
  /**
   * Entité portant cet `id`. L'unicité d'un `id` n'est garantie que **par driver**
   * (le topic est `home/state/<driver>/<id>`) : en cas de collision inter-drivers,
   * on retourne la plus récente. Pour lever l'ambiguïté : `getStates({ driver, id })`.
   */
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

  /**
   * Clé composite `${driver}/${id}` — miroir du topic MQTT.
   *
   * Deux drivers peuvent légitimement publier le même `entityId` (rien dans le
   * contrat ne l'interdit, seul le couple driver+id est unique). Avec une clé
   * `id` seule, le dernier arrivé écrasait silencieusement l'autre et le miroir
   * perdait une entité — y compris pour `getStates()`. La clé composite garde
   * les deux ; l'ambiguïté ne subsiste que sur `getState(id)`, qui la tranche
   * par la fraîcheur (`ts`) et signale la collision une fois par couple.
   */
  const entities = new Map<string, Entity>();
  const health = new Map<string, Health>();
  const manifests = new Map<string, Manifest>();
  /** signatures de collisions déjà journalisées : un warn par couple, pas par message */
  const reportedCollisions = new Set<string>();

  const entityKey = (driver: string, id: string): string => `${driver}/${id}`;

  const warnOnCollision = (incoming: Entity): void => {
    const others = new Set<string>();
    for (const known of entities.values()) {
      if (known.id === incoming.id && known.driver !== incoming.driver) others.add(known.driver);
    }
    if (others.size === 0) return;
    const drivers = [...others, incoming.driver].sort();
    const signature = `${incoming.id}::${drivers.join(',')}`;
    if (reportedCollisions.has(signature)) return;
    reportedCollisions.add(signature);
    logger.warn("collision d'entityId entre drivers", { id: incoming.id, drivers });
  };

  await bus.onState({}, (entity) => {
    warnOnCollision(entity);
    entities.set(entityKey(entity.driver, entity.id), entity);
    onChange?.(entity);
  });

  // Retained effacé (payload vide) = l'entité n'existe plus : le miroir doit la lâcher,
  // sinon un équipement retiré resterait visible jusqu'au redémarrage du core.
  await bus.onStateDeleted((parts) => {
    if (entities.delete(entityKey(parts.driver, parts.entityId))) {
      logger.info('entité retirée du miroir', { driver: parts.driver, id: parts.entityId });
    }
  });

  /**
   * health + discovery ne passent pas par `onState` : abonnements bruts + validation zod.
   * Déclaré AVANT le listener qui l'utilise (pas de TDZ latente).
   */
  const handleInfra = (channel: string, driver: string, raw: string): void => {
    // Payload vide = effacement du retained (sémantique MQTT), pas une erreur :
    // le driver ou l'outillage (cf. `closeQuietly` du CLI) retire sa trace.
    if (raw.length === 0) {
      if (channel === 'health') health.delete(driver);
      else if (channel === 'discovery') manifests.delete(driver);
      return;
    }
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

  bus.client.on('message', (topic, payload) => {
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[0] !== 'home') return;
    const [, channel, driver] = parts;
    if (channel === undefined || driver === undefined) return;
    try {
      handleInfra(channel, driver, payload.toString());
    } catch {
      logger.warn('payload illisible, jeté', { topic });
    }
  });
  await bus.client.subscribeAsync(['home/health/+', 'home/discovery/+'], { qos: 1 });

  return {
    getStates(selector = {}) {
      return [...entities.values()].filter((entity) => matchesSelector(entity, selector));
    },
    getState(id) {
      let latest: Entity | undefined;
      for (const entity of entities.values()) {
        if (entity.id !== id) continue;
        // `ts` est un ISO 8601 normalisé par le contrat : l'ordre lexicographique
        // vaut l'ordre chronologique. `>=` fait gagner le dernier reçu à ts égal.
        if (latest === undefined || entity.ts >= latest.ts) latest = entity;
      }
      return latest;
    },
    getHealth() {
      return health;
    },
    getManifests() {
      return manifests;
    },
  };
}
