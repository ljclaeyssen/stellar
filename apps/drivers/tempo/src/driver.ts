import type { Bus, Logger } from '@stellar/bus';
import type { Entity, Manifest, TempoValue } from '@stellar/contracts';
import type { TempoReader } from './reader.js';
import type { TempoColors, TempoCouleur } from './tempo.js';
import { addDays, nextBoundary, periodeAt, tempoDayKey, type Clock } from './time.js';

export const DRIVER_NAME = 'tempo';
export const DRIVER_VERSION = '0.1.0';
/** Entité unique du driver — pas de `room` : la couleur du jour est nationale. */
export const ENTITY_ID = 'tempo_jour';

/**
 * Cycles ratés d'affilée avant de marquer l'entité `stale` (ADR-009). Deux : un
 * hoquet d'API ne doit pas faire clignoter le bus, mais deux heures sans
 * nouvelle des deux sources, ça se dit — d'autant que la régulation P6 prend des
 * décisions coûteuses (préchauffe avant un jour rouge) sur cette entité.
 */
export const STALE_AFTER_FAILURES = 2;

/**
 * Programme un rappel unique et rend de quoi l'annuler.
 *
 * Couture délibérée : les frontières HP/HC tombent à heure fixe, et les tests
 * doivent pouvoir vérifier **le délai calculé** puis déclencher le rappel sans
 * attendre une heure ni geler `setTimeout` globalement (des `vi.useFakeTimers()`
 * casseraient le broker aedes et undici qui tournent dans la même suite).
 */
export type ScheduleFn = (delayMs: number, callback: () => void) => () => void;

const realSchedule: ScheduleFn = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export interface TempoDriverOptions {
  bus: Bus;
  reader: TempoReader;
  logger: Logger;
  /** Défaut 1 h : les données ne changent que deux fois par jour. */
  pollMs?: number;
  /** Horloge injectable — les tests la gèlent à une heure précise. */
  clock?: Clock;
  /** Programmateur des frontières HP/HC — `setTimeout` par défaut. */
  schedule?: ScheduleFn;
}

export interface TempoDriverHandle {
  /** Entité publiée `stale: true` : les deux sources sont muettes (ADR-009). */
  readonly stale: boolean;
  /** Dernière valeur publiée, `null` tant qu'aucune couleur n'a été obtenue. */
  readonly value: TempoValue | null;
  /** Couleurs connues, par clé de jour Tempo (observabilité et tests). */
  readonly colors: TempoColors;
  /** Instant de la prochaine bascule HP/HC (epoch ms). */
  readonly nextBoundaryAt: number;
  /** Un cycle de rafraîchissement — les timers l'appellent, les tests aussi. */
  poll(): Promise<void>;
  close(): void;
}

export function buildManifest(): Manifest {
  return {
    driver: DRIVER_NAME,
    version: DRIVER_VERSION,
    entities: [{ id: ENTITY_ID, kind: 'tempo' }],
    // Percept pur : aucune commande. On ne pilote pas la couleur du jour.
    commands: [],
  };
}

/**
 * Driver Tempo : traducteur pur (interdit n°1). Il publie ce que RTE et
 * l'opendata savent, et **rien de plus** — la politique énergétique (préchauffe
 * avant un jour rouge, PAC interdites en HP rouge) vit dans `apps/core`.
 *
 * Deux horloges le font battre, et c'est le point de conception du driver :
 *
 * - le **polling** (1 h) va chercher les couleurs : elles ne changent que deux
 *   fois par jour (publication du lendemain vers 11 h, bascule à 6 h) ;
 * - un **timer de frontière** republie à 6 h et 22 h **pile**, parce que la
 *   bascule HP/HC est une propriété de l'heure, pas des données. Attendre le
 *   prochain poll ferait vivre le core jusqu'à une heure avec une période
 *   fausse — inacceptable un jour rouge, où le kWh en HP coûte 4 à 5 fois plus.
 *   Cette republication se fait depuis le cache : elle est donc juste même si
 *   les deux APIs sont dans le noir.
 */
export async function startTempoDriver(options: TempoDriverOptions): Promise<TempoDriverHandle> {
  const { bus, reader, logger } = options;
  const pollMs = options.pollMs ?? 3_600_000;
  const clock = options.clock ?? Date.now;
  const schedule = options.schedule ?? realSchedule;

  /** Cache des couleurs connues : c'est lui qui rend les bascules autonomes. */
  let colors: Record<string, TempoCouleur> = {};
  let value: TempoValue | null = null;
  let failures = 0;
  let stale = false;
  let busy = false;
  let closed = false;
  let cancelBoundary: (() => void) | null = null;
  let boundaryAt = 0;

  /** Les jours dont le driver a besoin : le jour Tempo courant et le suivant. */
  const wantedDays = (now: number): [string, string] => {
    const today = tempoDayKey(now);
    return [today, addDays(today, 1)];
  };

  /**
   * Assemble la valeur du contrat à partir du cache. `null` si la couleur du
   * jour courant est inconnue : `TempoValue.couleurJour` n'admet pas
   * « inconnue » — mieux vaut ne rien publier que publier une couleur inventée.
   */
  const compose = (now: number): TempoValue | null => {
    const [today, tomorrow] = wantedDays(now);
    const couleurJour = colors[today];
    if (couleurJour === undefined) return null;
    return {
      couleurJour,
      couleurDemain: colors[tomorrow] ?? 'inconnue',
      periode: periodeAt(now),
    };
  };

  const toEntity = (tempo: TempoValue, now: number, isStale: boolean): Entity => ({
    id: ENTITY_ID,
    driver: DRIVER_NAME,
    kind: 'tempo',
    value: tempo,
    ts: new Date(now).toISOString(),
    ...(isStale ? { stale: true } : {}),
  });

  /** Une publication ratée ne doit ni tuer le driver ni passer inaperçue. */
  const publish = async (tempo: TempoValue, now: number, isStale: boolean): Promise<void> => {
    value = tempo;
    await bus.publishState(toEntity(tempo, now, isStale)).catch((err: unknown) => {
      logger.warn('publication state échouée', { entityId: ENTITY_ID, error: String(err) });
    });
  };

  /**
   * Publie l'état déduit du **cache**, sans réseau. C'est ce que fait le timer
   * de frontière : à 22 h la période bascule, à 6 h c'est le jour Tempo qui
   * change (la couleur de « demain » devient celle du jour, et demain redevient
   * inconnu jusqu'au prochain poll).
   */
  const publishFromCache = async (reason: string): Promise<boolean> => {
    const now = clock();
    const tempo = compose(now);
    if (tempo === null) {
      logger.debug('rien à publier depuis le cache', { reason });
      return false;
    }
    await publish(tempo, now, stale);
    logger.info('état Tempo publié', { reason, ...tempo, stale });
    return true;
  };

  /**
   * Cycle raté : au-delà du seuil, l'entité repart `stale: true` — une seule
   * fois, tant que la panne dure (republier à chaque échec n'apprendrait rien).
   */
  const onFailure = async (err: unknown): Promise<void> => {
    failures += 1;
    logger.warn('cycle Tempo échoué', {
      failures,
      error: err instanceof Error ? err.message : String(err),
    });
    if (failures < STALE_AFTER_FAILURES || stale) return;
    if (value === null) {
      // Rien n'a jamais été publié : il n'y a pas d'« ancien état » à conserver.
      logger.error(
        'aucune couleur Tempo obtenue depuis le démarrage — les deux sources sont muettes',
      );
      return;
    }
    stale = true;
    logger.warn('sources Tempo muettes, entité marquée stale (ADR-009)', { failures });
    await publishFromCache('stale');
  };

  /** Deux jours d'historique suffisent : le reste ne sert plus à personne. */
  const pruneCache = (now: number): void => {
    const floor = addDays(tempoDayKey(now), -2);
    for (const key of Object.keys(colors)) {
      if (key < floor) delete colors[key];
    }
  };

  const poll = async (): Promise<void> => {
    if (busy || closed) return;
    busy = true;
    try {
      const now = clock();
      const { colors: fresh, source } = await reader.read(wantedDays(now));
      // Fusion et non remplacement : une source qui « perd » le lendemain (RTE
      // avant 11 h) ne doit pas effacer ce qu'on savait déjà.
      colors = { ...colors, ...fresh };
      pruneCache(now);
      if (compose(clock()) === null) {
        throw new Error('couleur du jour Tempo introuvable après lecture');
      }

      const wasStale = stale;
      failures = 0;
      stale = false;
      await publishFromCache(wasStale ? 'retour de source' : 'poll');
      logger.debug('cycle Tempo réussi', { source });
    } catch (err) {
      await onFailure(err);
    } finally {
      busy = false;
    }
  };

  /**
   * Programme la prochaine frontière HP/HC. À l'échéance : republication
   * immédiate depuis le cache (la période, elle, est certaine), puis un poll —
   * à 6 h il y a de bonnes chances qu'une couleur de lendemain soit à récupérer.
   */
  const scheduleBoundary = (): void => {
    if (closed) return;
    const now = clock();
    boundaryAt = nextBoundary(now);
    const delayMs = Math.max(0, boundaryAt - now);
    logger.debug('prochaine bascule HP/HC programmée', {
      at: new Date(boundaryAt).toISOString(),
      delayMs,
    });
    cancelBoundary = schedule(delayMs, () => {
      void (async () => {
        if (closed) return;
        await publishFromCache('bascule HP/HC');
        scheduleBoundary();
        await poll();
      })();
    });
  };

  await bus.announce(buildManifest());
  // Premier passage immédiat : le bus doit avoir un état avant la première période.
  await poll();
  scheduleBoundary();

  const timer = setInterval(() => void poll(), pollMs);

  logger.info('driver tempo prêt', {
    pollMs,
    nextBoundaryAt: new Date(boundaryAt).toISOString(),
    ...(value ?? {}),
  });

  return {
    get stale() {
      return stale;
    },
    get value() {
      return value;
    },
    get colors() {
      return { ...colors };
    },
    get nextBoundaryAt() {
      return boundaryAt;
    },
    poll,
    close() {
      closed = true;
      clearInterval(timer);
      cancelBoundary?.();
      cancelBoundary = null;
    },
  };
}
