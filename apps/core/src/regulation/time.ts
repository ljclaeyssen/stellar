/**
 * Heure locale déterministe.
 *
 * La régulation raisonne en heure **locale** (« nuit à 22:30 », « préchauffe à
 * 02:00 », « heures pleines de 6 h à 22 h ») alors que tout le bus est en UTC.
 * La conversion passe par `Intl` avec un fuseau explicite : c'est la seule façon
 * de rester juste aux changements d'heure sans embarquer de base tzdata, et ça
 * reste 100 % déterministe (aucune dépendance à l'horloge ni au fuseau de la
 * machine — le paramètre `now` est toujours injecté).
 */

export interface LocalTime {
  /** `YYYY-MM-DD` local. */
  date: string;
  hour: number;
  minute: number;
  /** Minutes écoulées depuis minuit local — l'unité de comparaison des plages. */
  minutesOfDay: number;
  /** 0 = dimanche, 1 = lundi… */
  weekday: number;
}

/** Abréviations françaises, indexées par `LocalTime.weekday` (rendu des goldens). */
export const WEEKDAY_LABELS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'] as const;

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Un formateur par fuseau : `Intl.DateTimeFormat` coûte cher à construire. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known) return known;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export function localTime(now: number, timeZone: string): LocalTime {
  const parts = new Map<string, string>();
  for (const part of formatterFor(timeZone).formatToParts(new Date(now))) {
    parts.set(part.type, part.value);
  }
  const hour = Number(parts.get('hour') ?? '0');
  const minute = Number(parts.get('minute') ?? '0');
  return {
    date: `${parts.get('year') ?? '0000'}-${parts.get('month') ?? '00'}-${parts.get('day') ?? '00'}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    weekday: WEEKDAY_INDEX[parts.get('weekday') ?? ''] ?? 0,
  };
}

/** `'22:30'` → 1350. Le format est déjà garanti par le schéma zod de la config. */
export function parseTimeOfDay(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

/**
 * Appartenance à une plage horaire, **enjambement de minuit compris** : c'est le
 * cas nominal ici (nuit 22:30 → 06:30). Borne de début incluse, borne de fin
 * exclue — à 06:30 pile, la nuit est finie.
 */
export function inTimeRange(minutesOfDay: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minutesOfDay >= start && minutesOfDay < end;
  return minutesOfDay >= start || minutesOfDay < end;
}

/** Heures pleines : 6 h–22 h (spec §2). Sert de repli quand le percept tempo manque. */
export const HP_START_MIN = 6 * 60;
export const HP_END_MIN = 22 * 60;

export function derivePeriode(minutesOfDay: number): 'HP' | 'HC' {
  return inTimeRange(minutesOfDay, HP_START_MIN, HP_END_MIN) ? 'HP' : 'HC';
}
