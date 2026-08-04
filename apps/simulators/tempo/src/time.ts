/**
 * Calendrier Tempo côté simulateur.
 *
 * **Duplication assumée** avec `apps/drivers/tempo/src/time.ts` : un simulateur
 * ne doit dépendre d'aucun package du monorepo (règle des `apps/simulators/*`,
 * cf. sim-hue et sim-netatmo, sans dépendance runtime). Le jour où les deux
 * implémentations divergeraient, c'est un test du driver qui tomberait — ce qui
 * est exactement le rôle d'un simulateur indépendant.
 */
export const PARIS_TZ = 'Europe/Paris';

/** Heure de bascule d'un jour Tempo au suivant (heure locale de Paris). */
export const TEMPO_DAY_START_HOUR = 6;

const formatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface ParisParts {
  /** `YYYY-MM-DD` en heure locale de Paris. */
  dateKey: string;
  hour: number;
}

export function parisParts(epochMs: number): ParisParts {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const year = parts['year'] ?? '';
  const month = parts['month'] ?? '';
  const day = parts['day'] ?? '';
  const hour = Number(parts['hour'] ?? Number.NaN);
  if (year === '' || month === '' || day === '' || !Number.isInteger(hour)) {
    throw new Error(`sim-tempo: heure de Paris illisible pour ${String(epochMs)}`);
  }
  return { dateKey: `${year}-${month}-${day}`, hour };
}

/**
 * Clé du jour Tempo courant : la date locale, **décalée d'un jour en arrière
 * entre minuit et 6 h** (le jour Tempo commencé la veille à 6 h court encore).
 */
export function tempoDayKey(epochMs: number): string {
  const { dateKey, hour } = parisParts(epochMs);
  return hour < TEMPO_DAY_START_HOUR ? addDays(dateKey, -1) : dateKey;
}

export function addDays(dateKey: string, days: number): string {
  const at = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`sim-tempo: date invalide ${dateKey}`);
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/** Décalage UTC de Paris à cet instant, en ms (3 600 000 l'hiver, 7 200 000 l'été). */
function parisOffsetMs(epochMs: number): number {
  const seen: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') seen[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(seen['year']),
    Number(seen['month']) - 1,
    Number(seen['day']),
    Number(seen['hour']),
    Number(seen['minute']),
    Number(seen['second']),
  );
  return asUtc - Math.floor(epochMs / 1_000) * 1_000;
}

/**
 * Instant (epoch ms) d'une heure locale de Paris. Deux passes : la première
 * devine le décalage, la seconde le corrige si l'estimation tombait de l'autre
 * côté d'un changement d'heure. 6 h et 22 h ne sont jamais dans le trou de
 * printemps (2 h → 3 h), donc pas de troisième passe.
 */
export function parisEpochOf(dateKey: string, hour: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`sim-tempo: date invalide ${dateKey}`);
  }
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = naive - parisOffsetMs(naive);
  return naive - parisOffsetMs(first);
}

/** ISO 8601 avec l'offset de Paris (`2026-08-03T06:00:00+02:00`). */
export function parisIso(epochMs: number): string {
  const offsetMs = parisOffsetMs(epochMs);
  const sign = offsetMs < 0 ? '-' : '+';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  const local = new Date(epochMs + offsetMs).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}
