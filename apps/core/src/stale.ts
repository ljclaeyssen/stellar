import type { Bus, Logger } from '@stellar/bus';
import type { Entity, Kind } from '@stellar/contracts';
import type { Mirror } from './mirror.js';

/**
 * Détection de la **mort silencieuse** (P5, spec §10).
 *
 * Complémentaire de l'ADR-009 et surtout pas redondante :
 * - un driver marque `stale: true` ce qu'il **sait** injoignable (session TV
 *   perdue, SK103 qui ne répond plus) ;
 * - le core marque `stale: true` ce qui **se tait** — un capteur à pile qui a
 *   rendu l'âme ne prévient personne, et son dernier état retained resterait
 *   éternellement crédible.
 *
 * Deux règles qui ont l'air de détails et n'en sont pas :
 *
 * - **Le `ts` d'origine est conservé** à la republication. `ts` dit quand la
 *   donnée a été vue, pas quand on a constaté qu'elle était périmée. Le rafraîchir
 *   ferait mentir le journal et remettrait le compteur à zéro à chaque tick.
 * - **Le topic de republication vient de `entity.driver`**, donnée du miroir
 *   (ADR-008) : aucun nom de driver n'est écrit dans le core.
 */

const MINUTE = 60_000;

/**
 * Seuils par kind (spec §10). Table volontairement partielle : un kind absent
 * n'est jamais marqué stale par le core.
 *
 * - `temperature` / `humidity` (15 min) : capteurs Zigbee à pile, qui publient
 *   sur variation avec un heartbeat de l'ordre de quelques minutes.
 * - `presence` (5 min) : un mmWave muet 5 min est mort, pas immobile.
 * - `power` (2 min) : le ZLinky publie en continu.
 * - `climate` (150 s) : 3 × le polling midea (45 s), arrondi — la spec §9 impose
 *   un polling doux, trois tours manqués valent constat.
 * - `media`, `light`, `plug` : événementiels (SSE Hue, events TV) **et** déjà
 *   couverts par le driver (ADR-009) — un seuil ici ne ferait que doubler
 *   l'alerte avec un retard.
 * - `weather`, `tempo` : sources cloud à cadence lente, gérées par leur driver.
 */
export const DEFAULT_STALE_THRESHOLDS: Partial<Record<Kind, number>> = {
  temperature: 15 * MINUTE,
  humidity: 15 * MINUTE,
  presence: 5 * MINUTE,
  power: 2 * MINUTE,
  climate: 150_000,
};

/** `home/event/core/stale_alert` — data de l'événement publié sur le bus. */
export interface StaleAlert {
  entityId: string;
  driver: string;
  kind: Kind;
  /** `ts` du dernier état frais reçu (celui qui est resté figé). */
  lastSeenTs: string;
}

export interface StaleWatcherOptions {
  mirror: Mirror;
  bus: Bus;
  logger: Logger;
  /** Remplace la table par défaut (fusion, pas écrasement : voir `thresholds`). */
  thresholds?: Partial<Record<Kind, number>>;
  /** Défaut 30 s — un tick coûte une itération sur le miroir, pas plus. */
  checkIntervalMs?: number;
  /** Horloge injectable (tests). Défaut `Date.now`. */
  clock?: () => number;
}

export interface StaleWatcher {
  /** Un tour de vérification. Appelé par le timer, exposé pour les tests. */
  check(): Promise<void>;
  close(): void;
}

export function createStaleWatcher(options: StaleWatcherOptions): StaleWatcher {
  const { mirror, bus, logger } = options;
  const thresholds = { ...DEFAULT_STALE_THRESHOLDS, ...options.thresholds };
  const clock = options.clock ?? Date.now;
  const intervalMs = options.checkIntervalMs ?? 30_000;

  /**
   * `driver/id` → `ts` déjà signalé. Sert deux fois :
   * - le miroir ne reçoit notre republication qu'après un aller-retour broker :
   *   sans ce garde-fou, deux ticks rapprochés alerteraient deux fois ;
   * - une entité qui reparle change de `ts` : elle redevient donc alertable si
   *   elle se tait à nouveau, sans qu'on ait rien à nettoyer.
   */
  const alerted = new Map<string, string>();

  const markStale = async (entity: Entity, now: number): Promise<void> => {
    const key = `${entity.driver}/${entity.id}`;
    // `ts` conservé : c'est la date de la dernière donnée réelle.
    await bus.publishState({ ...entity, stale: true });
    await bus.publishEvent({
      driver: 'core',
      type: 'stale_alert',
      data: {
        entityId: entity.id,
        driver: entity.driver,
        kind: entity.kind,
        lastSeenTs: entity.ts,
      } satisfies StaleAlert,
      ts: new Date(now).toISOString(),
    });
    alerted.set(key, entity.ts);
    logger.warn('entité muette, marquée stale', {
      id: entity.id,
      kind: entity.kind,
      lastSeenTs: entity.ts,
      silenceMs: now - Date.parse(entity.ts),
    });
  };

  const check = async (): Promise<void> => {
    const now = clock();
    for (const entity of mirror.getStates()) {
      const threshold = thresholds[entity.kind];
      if (threshold === undefined) continue;
      // Déjà stale : soit le driver l'a posé (ADR-009), soit c'est notre propre
      // republication revenue par le bus. Dans les deux cas, rien à redire.
      if (entity.stale === true) continue;
      if (alerted.get(`${entity.driver}/${entity.id}`) === entity.ts) continue;

      const lastSeen = Date.parse(entity.ts);
      if (Number.isNaN(lastSeen)) continue;
      if (now - lastSeen <= threshold) continue;

      await markStale(entity, now);
    }
  };

  const timer = setInterval(() => {
    void check().catch((err: unknown) =>
      logger.error('échec du tour de détection stale', { error: String(err) }),
    );
  }, intervalMs);
  // Le watcher ne doit pas, à lui seul, maintenir le process en vie.
  timer.unref();

  return {
    check,
    close() {
      clearInterval(timer);
    },
  };
}
