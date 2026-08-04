import type { JournalRow } from '../journal.js';
import { localTime } from '../regulation/time.js';

/**
 * OCCUPATION PROBABILISTE (P9, spec §16) — **fonction pure**.
 *
 * Le préconditionnement a besoin d'une réponse à une seule question : « dans
 * trois quarts d'heure, y aura-t-il quelqu'un dans cette pièce ? ». Ce module la
 * calcule à partir du journal, et **rien d'autre** : aucun réseau, aucun LLM
 * (principe n°1 de la spec — le prédictif alimente une boucle de régulation, il
 * doit donc être déterministe, hors ligne, et rejouable).
 *
 * ## Le modèle, en trois phrases
 *
 * 1. La journée est découpée en créneaux de 30 min (48 par jour, heure locale).
 * 2. Les jours sont de deux types : `semaine` et `weekend` — c'est la seule
 *    saisonnalité que l'on prétend capturer, et c'est de très loin la plus forte
 *    dans une maison.
 * 3. Pour chaque (pièce, type de jour, créneau) on compte les jours où la pièce a
 *    été vue occupée, sur les jours où l'on savait, et on lisse par Laplace
 *    (α = 1) : `p = (occupés + 1) / (observés + 2)`.
 *
 * **Volontairement pas de ML.** Un modèle opaque qui décide d'allumer un
 * chauffage n'est pas relisible par l'humain qui paie la facture ; ici tout le
 * modèle tient dans un tableau de comptes que `formatProfile` rend en texte, et
 * chaque probabilité est justifiable par « 18 soirs sur 20 ».
 *
 * Le lissage a un rôle concret au-delà de l'élégance : il rend une probabilité
 * jamais exactement 0 ni 1, donc jamais une certitude — et il tire vers 0,5 les
 * créneaux peu observés, ce qui les fait naturellement échouer sous un seuil de
 * 0,6 avant même que `minObservations` ne s'applique.
 *
 * ## Ce qui compte comme une observation
 *
 * Un percept `presence` par pièce et par créneau, **hors republications stale**
 * (une republication stale n'est pas un fait neuf : c'est le core qui signale un
 * silence). Un créneau sans percept hérite de la dernière valeur connue **du même
 * jour local** : un capteur qui ne publie que sur changement décrit malgré tout
 * une soirée entière. Les créneaux antérieurs au premier percept du jour restent
 * inconnus — on ne les compte ni au numérateur ni au dénominateur.
 *
 * L'horodatage retenu est celui du **payload** (`entity.ts`, l'instant où le
 * capteur a vu), et non la colonne `ts` du journal (l'instant où le core a vu) :
 * au redémarrage du core, tous les états retained sont redélivrés d'un coup et
 * porteraient sinon l'heure du redémarrage — soit une fausse présence, chaque
 * fois, à l'heure des redémarrages.
 */

/** Le kind lu dans le journal. Ce n'est pas un nom de driver (spec règle n°7). */
export const PRESENCE_KIND = 'presence';

export type DayType = 'semaine' | 'weekend';

/** L'ordre est celui du rendu de `formatProfile`. */
export const DAY_TYPES: readonly DayType[] = ['semaine', 'weekend'];

export interface OccupancySlot {
  /** Jours (du même type) où l'occupation de ce créneau était connue. */
  observations: number;
  /** Parmi eux, ceux où la pièce a été vue occupée. */
  occupied: number;
  /** Fréquence lissée (Laplace α = 1) : jamais exactement 0 ni 1. */
  probability: number;
}

export interface OccupancyProfile {
  /** Instant de construction (ISO) — le profil est daté, il vieillit. */
  builtAt: string;
  /** Bornes de la fenêtre glissante réellement retenue (ISO). */
  from: string;
  to: string;
  windowDays: number;
  slotMin: number;
  slotsPerDay: number;
  /** Sous ce nombre de jours observés, `probabilityAt` refuse de répondre. */
  minObservations: number;
  timezone: string;
  /** Percepts retenus (lignes exploitables, republications stale exclues). */
  samples: number;
  /** Jours locaux distincts ayant produit au moins un percept, par type. */
  days: Readonly<Record<DayType, number>>;
  /** pièce → type de jour → un `OccupancySlot` par créneau (`slotsPerDay`). */
  rooms: Readonly<Record<string, Readonly<Record<DayType, OccupancySlot[]>>>>;
}

export interface OccupancyProfileOptions {
  /** Fin de la fenêtre glissante (epoch ms) — en pratique « maintenant ». */
  now: number;
  /** Défaut `Europe/Paris` (la maison est en région lilloise). */
  timezone?: string;
  /** Profondeur de la fenêtre glissante. Défaut 28 jours (4 semaines pleines). */
  windowDays?: number;
  /** Largeur d'un créneau, en minutes. Défaut 30. Doit diviser 1440. */
  slotMin?: number;
  /** Jours observés minimum pour qu'un créneau soit exploitable. Défaut 8. */
  minObservations?: number;
}

export const OCCUPANCY_DEFAULT_WINDOW_DAYS = 28;
export const OCCUPANCY_DEFAULT_SLOT_MIN = 30;
export const OCCUPANCY_DEFAULT_MIN_OBSERVATIONS = 8;

const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** Samedi et dimanche : la seule frontière de comportement qui vaille (spec §10). */
export function dayTypeOf(weekday: number): DayType {
  return weekday === 0 || weekday === 6 ? 'weekend' : 'semaine';
}

/** Laplace α = 1 sur deux classes (occupé / vide). */
function smooth(occupied: number, observations: number): number {
  return (occupied + 1) / (observations + 2);
}

/** Ce qu'on retient d'une ligne de journal : un fait « pièce vue (in)occupée ». */
interface PresenceSample {
  room: string;
  ts: number;
  occupied: boolean;
}

/**
 * Extraction tolérante : le journal contient tout, y compris des payloads
 * invalides (parti pris n°1 de `journal.ts`). Une ligne qu'on ne comprend pas est
 * ignorée sans bruit — elle ne doit pas empêcher les 1 300 autres de servir.
 */
function readSample(row: JournalRow): PresenceSample | undefined {
  if (row.kind !== null && row.kind !== PRESENCE_KIND) return undefined;
  if (row.payload.length === 0) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(row.payload);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const body = json as Record<string, unknown>;

  if (body['kind'] !== PRESENCE_KIND) return undefined;
  if (typeof body['value'] !== 'boolean') return undefined;
  // Une republication stale n'est pas une observation neuve : c'est le core qui
  // dit « ce capteur s'est tu ». La compter reconduirait indéfiniment la dernière
  // valeur vue, et un capteur mort finirait par « prouver » une occupation.
  if (body['stale'] === true) return undefined;

  const room = typeof body['room'] === 'string' ? body['room'] : undefined;
  if (room === undefined || room.length === 0) return undefined;

  const payloadTs = typeof body['ts'] === 'string' ? Date.parse(body['ts']) : Number.NaN;
  const ts = Number.isFinite(payloadTs) ? payloadTs : Date.parse(row.ts);
  if (!Number.isFinite(ts)) return undefined;

  return { room, ts, occupied: body['value'] };
}

/** Une journée locale d'une pièce : un état connu/inconnu par créneau. */
interface DayTrack {
  dayType: DayType;
  /** `true` occupé, `false` vide, `undefined` aucun percept dans le créneau. */
  raw: Array<boolean | undefined>;
}

/**
 * Construit le profil depuis des lignes de journal brutes.
 *
 * Les lignes peuvent arriver dans n'importe quel ordre et contenir n'importe
 * quoi : seules celles qui sont des percepts `presence` exploitables et qui
 * tombent dans la fenêtre `[now − windowDays, now]` sont retenues.
 */
export function buildOccupancyProfile(
  rows: readonly JournalRow[],
  options: OccupancyProfileOptions,
): OccupancyProfile {
  const timezone = options.timezone ?? 'Europe/Paris';
  const windowDays = options.windowDays ?? OCCUPANCY_DEFAULT_WINDOW_DAYS;
  const slotMin = options.slotMin ?? OCCUPANCY_DEFAULT_SLOT_MIN;
  const minObservations = options.minObservations ?? OCCUPANCY_DEFAULT_MIN_OBSERVATIONS;
  const slotsPerDay = Math.max(1, Math.floor(MINUTES_PER_DAY / slotMin));
  const to = options.now;
  const from = to - windowDays * DAY_MS;

  const samples: PresenceSample[] = [];
  for (const row of rows) {
    const sample = readSample(row);
    if (!sample) continue;
    if (sample.ts < from || sample.ts > to) continue;
    samples.push(sample);
  }
  // Ordre chronologique : la reconduction de la dernière valeur connue en dépend.
  samples.sort((a, b) => a.ts - b.ts);

  /** pièce → date locale (`YYYY-MM-DD`) → journée. */
  const tracks = new Map<string, Map<string, DayTrack>>();
  for (const sample of samples) {
    const local = localTime(sample.ts, timezone);
    const slot = Math.min(slotsPerDay - 1, Math.floor(local.minutesOfDay / slotMin));

    let days = tracks.get(sample.room);
    if (!days) {
      days = new Map<string, DayTrack>();
      tracks.set(sample.room, days);
    }
    let track = days.get(local.date);
    if (!track) {
      track = {
        dayType: dayTypeOf(local.weekday),
        raw: new Array<boolean | undefined>(slotsPerDay).fill(undefined),
      };
      days.set(local.date, track);
    }
    // « Au moins un percept `true` » l'emporte : une présence vue dans le créneau
    // est un fait, une absence vue n'est que l'instant d'avant ou d'après.
    track.raw[slot] = track.raw[slot] === true ? true : sample.occupied;
  }

  const rooms: Record<string, Record<DayType, OccupancySlot[]>> = {};
  const dayCount: Record<DayType, Set<string>> = { semaine: new Set(), weekend: new Set() };

  for (const room of [...tracks.keys()].sort()) {
    const days = tracks.get(room);
    if (!days) continue;

    const counts: Record<DayType, Array<{ observations: number; occupied: number }>> = {
      semaine: Array.from({ length: slotsPerDay }, () => ({ observations: 0, occupied: 0 })),
      weekend: Array.from({ length: slotsPerDay }, () => ({ observations: 0, occupied: 0 })),
    };

    for (const [date, track] of days) {
      dayCount[track.dayType].add(date);
      const bucket = counts[track.dayType];
      let last: boolean | undefined;
      for (let slot = 0; slot < slotsPerDay; slot += 1) {
        // Reconduction : un capteur qui ne publie que sur changement décrit
        // quand même toute la plage qui suit son dernier message.
        const value = track.raw[slot] ?? last;
        last = value;
        if (value === undefined) continue;
        const cell = bucket[slot];
        if (!cell) continue;
        cell.observations += 1;
        if (value) cell.occupied += 1;
      }
    }

    rooms[room] = {
      semaine: counts.semaine.map((cell) => ({
        observations: cell.observations,
        occupied: cell.occupied,
        probability: smooth(cell.occupied, cell.observations),
      })),
      weekend: counts.weekend.map((cell) => ({
        observations: cell.observations,
        occupied: cell.occupied,
        probability: smooth(cell.occupied, cell.observations),
      })),
    };
  }

  return {
    builtAt: new Date(to).toISOString(),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    windowDays,
    slotMin,
    slotsPerDay,
    minObservations,
    timezone,
    samples: samples.length,
    days: { semaine: dayCount.semaine.size, weekend: dayCount.weekend.size },
    rooms,
  };
}

/**
 * Probabilité d'occupation d'une pièce à un instant donné.
 *
 * `undefined` signifie **« je ne sais pas »**, jamais « probablement vide » : la
 * régulation doit pouvoir distinguer les deux, et un profil trop jeune ne doit
 * rien déclencher. Deux cas : la pièce est inconnue du profil, ou le créneau a
 * été observé moins de `minObservations` jours du même type.
 */
export function probabilityAt(
  profile: OccupancyProfile,
  room: string,
  date: Date | number,
): number | undefined {
  const ts = typeof date === 'number' ? date : date.getTime();
  if (!Number.isFinite(ts)) return undefined;
  const local = localTime(ts, profile.timezone);
  const slot = Math.min(profile.slotsPerDay - 1, Math.floor(local.minutesOfDay / profile.slotMin));
  const cell = profile.rooms[room]?.[dayTypeOf(local.weekday)]?.[slot];
  if (!cell) return undefined;
  if (cell.observations < profile.minObservations) return undefined;
  return cell.probability;
}

/** `35` → `'17:30'` (créneaux de 30 min). */
function slotLabel(slot: number, slotMin: number): string {
  const minutes = slot * slotMin;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Rendu texte du profil — l'exigence « mesurable » du DoD P9.
 *
 * Un modèle qui décide de chauffer doit pouvoir être **relu** : ces quelques
 * lignes sont tout le modèle, comptes bruts compris. C'est aussi ce qui est
 * committé dans le golden 07, donc ce qu'une revue voit changer.
 */
export function formatProfile(profile: OccupancyProfile): string {
  /** `'0.94 (15/15)'`, ou `'   — (0/6)'` quand le créneau est sous le seuil. */
  const cell = (slot: OccupancySlot | undefined): string => {
    if (!slot) return '   — (0/0)'.padEnd(15);
    const value =
      slot.observations < profile.minObservations ? '   —' : slot.probability.toFixed(2);
    return `${value} (${slot.occupied}/${slot.observations})`.padEnd(15);
  };

  const lines = [
    `profil d'occupation · fenêtre ${profile.from} → ${profile.to} (${profile.windowDays} j, ${profile.timezone})`,
    `créneaux de ${profile.slotMin} min · lissage de Laplace α=1 · seuil ${profile.minObservations} jours observés`,
    `${profile.samples} percepts retenus · ${profile.days.semaine} jours de semaine, ${profile.days.weekend} de week-end`,
    `« p (n/N) » : n jours occupés sur N jours observés · « — » : sous le seuil, probabilité non rendue`,
  ];

  const names = Object.keys(profile.rooms).sort();
  if (names.length === 0) lines.push('', '(aucune pièce observée)');

  for (const room of names) {
    const byType = profile.rooms[room];
    lines.push('', room, `  créneau  ${'semaine'.padEnd(15)}weekend`);
    for (let slot = 0; slot < profile.slotsPerDay; slot += 1) {
      const semaine = byType?.semaine[slot];
      const weekend = byType?.weekend[slot];
      if ((semaine?.observations ?? 0) === 0 && (weekend?.observations ?? 0) === 0) continue;
      lines.push(
        `  ${slotLabel(slot, profile.slotMin)}    ${cell(semaine)}${cell(weekend)}`.trimEnd(),
      );
    }
  }

  return lines.join('\n');
}
