/**
 * Calendrier Tempo — **toute** l'arithmétique de dates du driver vit ici.
 *
 * Trois règles de la spec §2, et une seule source de vérité pour les tenir :
 *
 * 1. Un **jour Tempo** court de 6 h à 6 h le lendemain, heure locale de France.
 *    Entre minuit et 6 h, le jour Tempo courant est donc celui commencé **la
 *    veille** — c'est le « wrap » qui piège toute implémentation naïve.
 * 2. **HP** = 6 h–22 h, **HC** = 22 h–6 h, heure locale elle aussi.
 * 3. Heure locale = `Europe/Paris`, via `Intl` : **aucun offset en dur**. Un
 *    `+01:00` codé en dur ferait mentir le driver la moitié de l'année, et
 *    surtout se tromper de bascule HP/HC les deux nuits de changement d'heure.
 *
 * L'horloge est injectable partout (`Clock`) : la régulation P6 et ses golden
 * tests exigent un comportement reproductible à horloge fixée (ADR-010).
 */
export type Clock = () => number;

export const PARIS_TZ = 'Europe/Paris';

/** Heure locale de bascule d'un jour Tempo au suivant. */
export const TEMPO_DAY_START_HOUR = 6;
/** Frontières HP/HC, heure locale (spec §2 : HP = 6 h–22 h). */
export const HP_START_HOUR = 6;
export const HP_END_HOUR = 22;

export type Periode = 'HP' | 'HC';

/**
 * `hourCycle: 'h23'` et non `hour12: false` : selon les versions d'ICU, ce
 * dernier peut rendre « 24 » à minuit en fr-FR — de quoi rater une bascule.
 */
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
  /** Date locale `YYYY-MM-DD` (date **calendaire**, pas la clé de jour Tempo). */
  dateKey: string;
  hour: number;
  minute: number;
  second: number;
}

function rawParts(epochMs: number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

export function parisParts(epochMs: number): ParisParts {
  const parts = rawParts(epochMs);
  const year = parts['year'] ?? '';
  const month = parts['month'] ?? '';
  const day = parts['day'] ?? '';
  const hour = Number(parts['hour'] ?? Number.NaN);
  const minute = Number(parts['minute'] ?? Number.NaN);
  const second = Number(parts['second'] ?? Number.NaN);
  if (year === '' || month === '' || day === '' || !Number.isInteger(hour)) {
    throw new Error(`heure de Paris illisible pour l’instant ${String(epochMs)}`);
  }
  return { dateKey: `${year}-${month}-${day}`, hour, minute, second };
}

/** Décalage UTC de Paris à cet instant, en ms (+1 h l'hiver, +2 h l'été). */
export function parisOffsetMs(epochMs: number): number {
  const parts = rawParts(epochMs);
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  // L'instant est tronqué à la seconde : `formatToParts` n'expose pas les ms.
  return asUtc - Math.floor(epochMs / 1_000) * 1_000;
}

/**
 * Instant (epoch ms) d'une heure locale de Paris.
 *
 * Deux passes : la première devine le décalage en lisant la date comme si elle
 * était UTC, la seconde le corrige quand cette estimation tombait de l'autre
 * côté d'un changement d'heure. Les heures manipulées ici (6 h, 11 h, 22 h) ne
 * tombent jamais dans le trou du printemps (2 h → 3 h) : deux passes suffisent.
 */
export function parisEpochOf(dateKey: string, hour: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`date invalide: ${dateKey}`);
  }
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = naive - parisOffsetMs(naive);
  return naive - parisOffsetMs(first);
}

/** `YYYY-MM-DD` décalé de `days` jours calendaires. */
export function addDays(dateKey: string, days: number): string {
  const at = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`date invalide: ${dateKey}`);
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Clé (`YYYY-MM-DD`) du jour Tempo en cours à cet instant — **le wrap de 6 h**.
 * À 3 h du matin le 4, on est encore dans le jour Tempo du 3.
 */
export function tempoDayKey(epochMs: number): string {
  const { dateKey, hour } = parisParts(epochMs);
  return hour < TEMPO_DAY_START_HOUR ? addDays(dateKey, -1) : dateKey;
}

/** HP entre 6 h et 22 h locales, HC le reste du temps (spec §2). */
export function periodeAt(epochMs: number): Periode {
  const { hour } = parisParts(epochMs);
  return hour >= HP_START_HOUR && hour < HP_END_HOUR ? 'HP' : 'HC';
}

/**
 * Prochaine frontière HP/HC **strictement** après `epochMs` : 6 h ou 22 h
 * locales. Calculée en heure de Paris, donc juste les nuits de changement
 * d'heure (le 29 mars 2026, de 22 h 30 à 6 h il n'y a que 6 h 30 réelles).
 */
export function nextBoundary(epochMs: number): number {
  const { dateKey } = parisParts(epochMs);
  const candidates = [
    parisEpochOf(dateKey, HP_START_HOUR),
    parisEpochOf(dateKey, HP_END_HOUR),
    parisEpochOf(addDays(dateKey, 1), HP_START_HOUR),
    parisEpochOf(addDays(dateKey, 1), HP_END_HOUR),
  ];
  const next = candidates.find((candidate) => candidate > epochMs);
  if (next === undefined) throw new Error(`aucune frontière HP/HC après ${String(epochMs)}`);
  return next;
}

/** ISO 8601 avec l'offset de Paris — format attendu par l'API RTE. */
export function parisIso(epochMs: number): string {
  const offsetMs = parisOffsetMs(epochMs);
  const sign = offsetMs < 0 ? '-' : '+';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  return `${new Date(epochMs + offsetMs).toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/**
 * Clé de jour Tempo d'un **début de période** renvoyé par une API (`start_date`
 * chez RTE) : la date locale de Paris de cet instant.
 *
 * Attention, ce n'est **pas** la règle du wrap de `tempoDayKey` — et ce n'est
 * pas non plus une découpe des 10 premiers caractères de la chaîne :
 *
 * - une période publiée à `T06:00:00` (convention documentée) porte la date du
 *   jour Tempo qu'elle ouvre : date locale, sans wrap ;
 * - une période publiée à `T00:00:00` (convention rencontrée sur d'autres jeux
 *   de données ouverts) porte elle aussi la date du jour Tempo concerné — un
 *   wrap la ferait reculer d'un jour, c'est-à-dire mentir d'un jour ;
 * - une date servie en UTC (`2026-08-03T04:00:00Z`, soit 6 h à Paris) retombe
 *   sur la bonne date parce qu'on repasse par le fuseau local.
 *
 * Bref : quelle que soit la convention d'heure, la date **locale** du début de
 * période nomme le jour Tempo. À reconfirmer sur la vraie réponse RTE au
 * premier `verify` (cf. `__fixtures__/README.md`).
 */
export function dayKeyOfPeriodStart(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new Error(`date ISO invalide: ${iso}`);
  return parisParts(at).dateKey;
}
