import type { Logger } from '@stellar/bus';
import type { JournalQuery, JournalRow } from '../journal.js';
import {
  buildOccupancyProfile,
  OCCUPANCY_DEFAULT_MIN_OBSERVATIONS,
  OCCUPANCY_DEFAULT_SLOT_MIN,
  OCCUPANCY_DEFAULT_WINDOW_DAYS,
  PRESENCE_KIND,
  type OccupancyProfile,
} from './occupancy.js';

/**
 * Cache horodaté du profil d'occupation (P9).
 *
 * Le profil est une **agrégation de quatre semaines de journal** : quelques
 * dizaines de milliers de lignes SQLite à relire et à replier. La régulation,
 * elle, tourne au moins une fois par minute et à chaque percept — la recalculer à
 * chaque tour coûterait plus cher que tout le reste du core réuni, pour un
 * résultat qui ne bouge pas d'un iota entre deux tours.
 *
 * D'où ce cache : **une reconstruction par heure au plus**, sur horloge injectée
 * (donc testable et déterministe). Une heure est très en deçà de la vitesse à
 * laquelle un profil de 28 jours peut changer d'avis, et très au-dessus de la
 * fréquence des tours.
 *
 * Une reconstruction qui échoue (journal verrouillé, disque plein) ne fait pas
 * tomber la régulation : on garde le profil précédent, on le signale, et on
 * réessaie à l'échéance suivante — jamais en boucle.
 */

/** La part du journal dont le prédictif a besoin (couture, donc testable). */
export interface OccupancyJournal {
  query(query?: JournalQuery): JournalRow[];
}

export interface OccupancyProfileCacheOptions {
  journal: OccupancyJournal;
  /** Celui de la régulation : le profil raisonne en heure locale. */
  timezone: string;
  windowDays?: number;
  slotMin?: number;
  minObservations?: number;
  /** Âge maximal du profil. Défaut 1 h. */
  refreshIntervalMs?: number;
  /**
   * Plafond de lignes lues d'un coup. Défaut 200 000 — soit, à un percept par
   * minute et par capteur, très au-delà de 28 jours de maison.
   */
  maxRows?: number;
  logger?: Logger;
}

export interface OccupancyProfileCache {
  /** Profil valide à cet instant, reconstruit si le précédent a plus d'une heure. */
  get(now: number): OccupancyProfile | undefined;
  /** Nombre de reconstructions tentées (introspection, tests). */
  readonly builds: number;
}

export const OCCUPANCY_DEFAULT_REFRESH_MS = 3_600_000;
export const OCCUPANCY_DEFAULT_MAX_ROWS = 200_000;

const DAY_MS = 86_400_000;

export function createOccupancyProfileCache(
  options: OccupancyProfileCacheOptions,
): OccupancyProfileCache {
  const { journal, timezone, logger } = options;
  const windowDays = options.windowDays ?? OCCUPANCY_DEFAULT_WINDOW_DAYS;
  const slotMin = options.slotMin ?? OCCUPANCY_DEFAULT_SLOT_MIN;
  const minObservations = options.minObservations ?? OCCUPANCY_DEFAULT_MIN_OBSERVATIONS;
  const refreshIntervalMs = options.refreshIntervalMs ?? OCCUPANCY_DEFAULT_REFRESH_MS;
  const maxRows = options.maxRows ?? OCCUPANCY_DEFAULT_MAX_ROWS;

  let profile: OccupancyProfile | undefined;
  let builtAt: number | undefined;
  let builds = 0;

  const build = (now: number): void => {
    // L'échéance est posée avant la tentative : un journal en erreur doit se
    // plaindre une fois par heure, pas à chaque tour de régulation.
    builtAt = now;
    builds += 1;
    try {
      // `desc` + limite : si le plafond est atteint, on garde les lignes les plus
      // RÉCENTES. Les prendre par le début donnerait une fenêtre décalée dans le
      // passé — un profil faux plutôt qu'un profil court.
      const rows = journal.query({
        kind: PRESENCE_KIND,
        from: new Date(now - windowDays * DAY_MS).toISOString(),
        order: 'desc',
        limit: maxRows,
      });
      if (rows.length >= maxRows) {
        logger?.warn('profil d’occupation tronqué : plafond de lignes atteint', {
          maxRows,
          windowDays,
        });
      }
      profile = buildOccupancyProfile(rows, {
        now,
        timezone,
        windowDays,
        slotMin,
        minObservations,
      });
      logger?.debug('profil d’occupation reconstruit', {
        samples: profile.samples,
        rooms: Object.keys(profile.rooms).length,
        joursSemaine: profile.days.semaine,
        joursWeekend: profile.days.weekend,
      });
    } catch (err) {
      logger?.warn('profil d’occupation non reconstruit', { error: String(err) });
    }
  };

  return {
    get(now) {
      if (builtAt === undefined || now - builtAt >= refreshIntervalMs) build(now);
      return profile;
    },
    get builds() {
      return builds;
    },
  };
}
