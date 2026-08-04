import { describe, expect, it } from 'vitest';
import type { JournalRow } from '../journal.js';
import { localTime } from '../regulation/time.js';
import { buildOccupancyProfile, formatProfile, probabilityAt } from './occupancy.js';

/**
 * OCCUPATION PROBABILISTE (P9) — le modèle, sans broker ni SQLite.
 *
 * `buildOccupancyProfile` est pure : on lui donne des lignes de journal
 * synthétiques (trois semaines de mmWave bien élevé) et on relit ce qu'elle en
 * déduit. Les valeurs attendues sont calculables à la main — c'est tout l'intérêt
 * d'un modèle en comptes lissés plutôt qu'en poids appris.
 */

const TZ = 'Europe/Paris';
/** 2026-01-15 00:00 heure locale (Europe/Paris, UTC+1 en janvier) — un jeudi. */
const JANVIER_15_MINUIT = Date.UTC(2026, 0, 14, 23, 0);
/** 2026-01-17 00:00 locale — un samedi. */
const JANVIER_17_MINUIT = JANVIER_15_MINUIT + 2 * 86_400_000;

const DAY = 86_400_000;
const HALF_HOUR = 1_800_000;
const heures = (n: number): number => n * 3_600_000;
/** Minutes locales depuis minuit → instant du jeudi 15 janvier. */
const jeudi = (minutes: number): number => JANVIER_15_MINUIT + minutes * 60_000;
const samedi = (minutes: number): number => JANVIER_17_MINUIT + minutes * 60_000;

/** L'instant depuis lequel on regarde : jeudi 15 janvier, 17 h locales. */
const MAINTENANT = JANVIER_15_MINUIT + heures(17);

let seq = 0;

interface RowOptions {
  /** Republication de veille : ce n'est pas une observation neuve. */
  stale?: boolean;
  /** Heure portée par la colonne `ts` du journal, si elle diffère du payload. */
  seenAt?: number;
}

function presenceRow(
  room: string,
  ts: number,
  value: boolean,
  options: RowOptions = {},
): JournalRow {
  seq += 1;
  const entityId = `presence_${room}`;
  const payload = JSON.stringify({
    id: entityId,
    driver: 'fakepercepts',
    kind: 'presence',
    room,
    value,
    ts: new Date(ts).toISOString(),
    ...(options.stale === true ? { stale: true } : {}),
  });
  return {
    id: seq,
    ts: new Date(options.seenAt ?? ts).toISOString(),
    topic: `home/state/fakepercepts/${entityId}`,
    driver: 'fakepercepts',
    entityId,
    kind: 'presence',
    payload,
    issuedBy: null,
  };
}

type Range = readonly [number, number];

interface HistoriqueOptions {
  room: string;
  /** Minuit local du lendemain du dernier jour couvert. */
  until: number;
  days: number;
  /** Plages occupées en semaine, en minutes locales : `[début, fin)`. */
  ranges: readonly Range[];
  /** Idem le week-end. Défaut : jamais occupée. */
  weekendRanges?: readonly Range[];
}

/** Un mmWave bien élevé : il republie son état toutes les 30 min, tous les jours. */
function historique(options: HistoriqueOptions): JournalRow[] {
  const rows: JournalRow[] = [];
  for (let day = 1; day <= options.days; day += 1) {
    const midnight = options.until - day * DAY;
    for (let slot = 0; slot < 48; slot += 1) {
      const ts = midnight + slot * HALF_HOUR;
      const { weekday } = localTime(ts, TZ);
      const ranges =
        weekday === 0 || weekday === 6 ? (options.weekendRanges ?? []) : options.ranges;
      const minute = slot * 30;
      const occupied = ranges.some(([from, to]) => minute >= from && minute < to);
      rows.push(presenceRow(options.room, ts, occupied));
    }
  }
  return rows;
}

/** 18:30 → 23:00, tous les soirs de semaine. */
const SOIREE: readonly Range[] = [[18 * 60 + 30, 23 * 60]];

const build = (rows: readonly JournalRow[], now = MAINTENANT, minObservations?: number) =>
  buildOccupancyProfile(rows, {
    now,
    timezone: TZ,
    ...(minObservations !== undefined ? { minObservations } : {}),
  });

describe('profil d’occupation — trois semaines de présence régulière', () => {
  const rows = historique({ room: 'salon', until: JANVIER_15_MINUIT, days: 21, ranges: SOIREE });
  const profile = build(rows);

  it('retient les 21 jours et les compte par type', () => {
    expect(profile.samples).toBe(21 * 48);
    // Du 25 décembre au 14 janvier : 15 jours de semaine, 6 de week-end.
    expect(profile.days).toEqual({ semaine: 15, weekend: 6 });
    expect(profile.slotsPerDay).toBe(48);
    expect(profile.windowDays).toBe(28);
  });

  it('donne une probabilité haute sur le créneau occupé, basse ailleurs', () => {
    // 15 soirs sur 15 : (15 + 1) / (15 + 2).
    expect(probabilityAt(profile, 'salon', jeudi(18 * 60 + 30))).toBeCloseTo(16 / 17, 6);
    expect(probabilityAt(profile, 'salon', jeudi(20 * 60))).toBeCloseTo(16 / 17, 6);
    // 0 soir sur 15 : (0 + 1) / (15 + 2).
    expect(probabilityAt(profile, 'salon', jeudi(17 * 60 + 30))).toBeCloseTo(1 / 17, 6);
    expect(probabilityAt(profile, 'salon', jeudi(10 * 60))).toBeCloseTo(1 / 17, 6);
  });

  it('accepte aussi bien un `Date` qu’un epoch', () => {
    expect(probabilityAt(profile, 'salon', new Date(jeudi(18 * 60 + 30)))).toBe(
      probabilityAt(profile, 'salon', jeudi(18 * 60 + 30)),
    );
  });

  it('lisse : jamais exactement 0, jamais exactement 1', () => {
    const soir = probabilityAt(profile, 'salon', jeudi(20 * 60));
    const matin = probabilityAt(profile, 'salon', jeudi(10 * 60));
    expect(soir).toBeLessThan(1);
    expect(soir).toBeGreaterThan(0.9);
    expect(matin).toBeGreaterThan(0);
    expect(matin).toBeLessThan(0.1);
  });

  it('refuse de répondre sous le seuil d’observations (6 week-ends < 8)', () => {
    // Le créneau existe et vaut 1/8 — mais six samedis ne font pas une habitude.
    expect(profile.rooms['salon']?.weekend[41]).toEqual({
      observations: 6,
      occupied: 0,
      probability: 1 / 8,
    });
    expect(probabilityAt(profile, 'salon', samedi(20 * 60))).toBeUndefined();
    // Seuil abaissé : la même donnée redevient exploitable. Le seuil est une
    // politique de prudence, pas une propriété du modèle.
    expect(probabilityAt(build(rows, MAINTENANT, 6), 'salon', samedi(20 * 60))).toBeCloseTo(
      1 / 8,
      6,
    );
  });

  it('ne connaît pas les pièces dont le journal ne parle pas', () => {
    expect(probabilityAt(profile, 'chambre', jeudi(20 * 60))).toBeUndefined();
  });
});

describe('profil d’occupation — semaine et week-end sont deux régimes distincts', () => {
  // 28 jours : huit samedis-dimanches, juste ce qu'il faut pour le seuil par défaut.
  const profile = build(
    historique({
      room: 'salon',
      until: JANVIER_15_MINUIT,
      days: 28,
      ranges: SOIREE,
      // Le week-end, le salon est occupé l'après-midi et pas le soir.
      weekendRanges: [[14 * 60, 18 * 60]],
    }),
  );

  it('sépare les deux types de jour sur le même créneau', () => {
    expect(profile.days).toEqual({ semaine: 20, weekend: 8 });
    // 15:00 : vide en semaine, occupé le week-end.
    expect(probabilityAt(profile, 'salon', jeudi(15 * 60))).toBeLessThan(0.1);
    expect(probabilityAt(profile, 'salon', samedi(15 * 60))).toBeGreaterThan(0.85);
    // 20:00 : l'inverse exact.
    expect(probabilityAt(profile, 'salon', jeudi(20 * 60))).toBeGreaterThan(0.9);
    expect(probabilityAt(profile, 'salon', samedi(20 * 60))).toBeLessThan(0.15);
  });

  it('coupe la fenêtre glissante à 28 jours', () => {
    // Le 18 décembre n'est couvert qu'à partir de 17 h (la fenêtre commence là).
    expect(profile.rooms['salon']?.semaine[20]?.observations).toBe(19);
    expect(profile.rooms['salon']?.semaine[40]?.observations).toBe(20);
  });
});

describe('profil d’occupation — ce qui compte comme une observation', () => {
  const base = historique({
    room: 'salon',
    until: JANVIER_15_MINUIT,
    days: 21,
    // Jamais personne le soir : c'est cette conclusion qu'on essaie de corrompre.
    ranges: [],
  });

  it('ignore les republications stale (un capteur mort ne prouve rien)', () => {
    const menteur = [
      ...base,
      ...Array.from({ length: 15 }, (_, index) =>
        presenceRow('salon', JANVIER_15_MINUIT - (index + 1) * DAY + heures(20), true, {
          stale: true,
        }),
      ),
    ];
    const profile = build(menteur);
    expect(profile.samples).toBe(21 * 48);
    expect(probabilityAt(profile, 'salon', jeudi(20 * 60))).toBeCloseTo(1 / 17, 6);
  });

  it('date le fait par le payload, pas par la colonne du journal', () => {
    // Redémarrage du core : tous les retained sont redélivrés à 03:00, mais ils
    // décrivent bien une présence de 20:00 la veille.
    const profile = build([
      ...base,
      ...Array.from({ length: 15 }, (_, index) =>
        presenceRow('salon', JANVIER_15_MINUIT - (index + 1) * DAY + heures(20), true, {
          seenAt: JANVIER_15_MINUIT - index * DAY + heures(3),
        }),
      ),
    ]);
    // Le créneau de 20:00 bascule ; celui de 03:00 (heure de la redélivrance) non.
    expect(probabilityAt(profile, 'salon', jeudi(20 * 60))).toBeGreaterThan(0.5);
    expect(probabilityAt(profile, 'salon', jeudi(3 * 60))).toBeCloseTo(1 / 17, 6);
  });

  it('ignore les lignes illisibles sans se plaindre (le journal contient tout)', () => {
    const bruit: JournalRow[] = [
      { ...presenceRow('salon', jeudi(0), true), payload: '' },
      { ...presenceRow('salon', jeudi(0), true), payload: 'pas du json' },
      { ...presenceRow('salon', jeudi(0), true), payload: '{"kind":"temperature","value":19}' },
      { ...presenceRow('salon', jeudi(0), true), payload: '{"kind":"presence","value":"oui"}' },
      // Percept `presence` sans pièce : inexploitable pour un profil par pièce.
      { ...presenceRow('salon', jeudi(0), true), payload: '{"kind":"presence","value":true}' },
    ];
    expect(build([...base, ...bruit]).samples).toBe(21 * 48);
  });

  it('ignore ce qui est hors de la fenêtre', () => {
    const vieux = presenceRow('salon', JANVIER_15_MINUIT - 40 * DAY + heures(20), true);
    const futur = presenceRow('salon', MAINTENANT + heures(2), true);
    expect(build([...base, vieux, futur]).samples).toBe(21 * 48);
  });
});

describe('profil d’occupation — capteur qui ne publie que sur changement', () => {
  /** Trois messages par jour, comme un contact de porte ou un mmWave économe. */
  const rows: JournalRow[] = [];
  for (let day = 1; day <= 21; day += 1) {
    const midnight = JANVIER_15_MINUIT - day * DAY;
    rows.push(presenceRow('bureau', midnight + heures(8), false));
    rows.push(presenceRow('bureau', midnight + heures(18) + 30 * 60_000, true));
    rows.push(presenceRow('bureau', midnight + heures(23), false));
  }
  const profile = build(rows);

  it('reconduit la dernière valeur connue du jour', () => {
    expect(profile.samples).toBe(21 * 3);
    // Aucun percept à 20:00, mais celui de 18:30 vaut encore.
    expect(probabilityAt(profile, 'bureau', jeudi(20 * 60))).toBeCloseTo(16 / 17, 6);
    // Aucun percept à 12:00 non plus : c'est le « false » de 8 h qui court.
    expect(probabilityAt(profile, 'bureau', jeudi(12 * 60))).toBeCloseTo(1 / 17, 6);
  });

  it('ne reconduit rien avant le premier percept du jour', () => {
    // 07:00 : la veille s'est terminée à 23:00, mais un jour ne déteint pas sur
    // le suivant — le créneau reste inconnu, donc non compté.
    expect(profile.rooms['bureau']?.semaine[14]?.observations).toBe(0);
    expect(probabilityAt(profile, 'bureau', jeudi(7 * 60))).toBeUndefined();
  });
});

describe('formatProfile — le modèle doit se relire', () => {
  const profile = build(
    historique({ room: 'salon', until: JANVIER_15_MINUIT, days: 21, ranges: SOIREE }),
  );
  const rendu = formatProfile(profile);

  it('rend la fenêtre, la méthode et le seuil', () => {
    expect(rendu).toContain("profil d'occupation");
    expect(rendu).toContain('28 j, Europe/Paris');
    expect(rendu).toContain('Laplace α=1');
    expect(rendu).toContain('seuil 8 jours observés');
    expect(rendu).toContain('1008 percepts retenus');
    expect(rendu).toContain('15 jours de semaine, 6 de week-end');
  });

  it('rend les comptes bruts derrière chaque probabilité', () => {
    const soir = rendu.split('\n').find((line) => line.startsWith('  20:00'));
    expect(soir).toBeDefined();
    // Semaine : 15/15 exploitables. Week-end : 0/6, sous le seuil → pas de valeur.
    expect(soir).toContain('0.94 (15/15)');
    expect(soir).toContain('— (0/6)');
  });

  it('nomme les pièces et les colonnes', () => {
    expect(rendu).toContain('\nsalon\n');
    expect(rendu).toContain('créneau');
    expect(rendu).toContain('semaine');
    expect(rendu).toContain('weekend');
  });

  it('reste lisible quand il n’y a rien à dire', () => {
    expect(formatProfile(build([]))).toContain('(aucune pièce observée)');
  });
});
