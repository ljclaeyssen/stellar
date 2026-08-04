import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayKeyOfPeriodStart,
  nextBoundary,
  parisEpochOf,
  parisIso,
  periodeAt,
  tempoDayKey,
} from './time.js';

/**
 * Tests purs du calendrier Tempo — sans réseau ni broker.
 *
 * L'heure d'été est traitée comme un cas nominal, pas comme un cas limite :
 * en 2026, la France avance ses montres le **29 mars** (2 h → 3 h) et les
 * recule le **25 octobre** (3 h → 2 h). Ces deux nuits-là, la bascule HP/HC
 * n'est pas à la même distance en temps réel qu'en temps local — un driver qui
 * additionnerait des heures se tromperait deux fois par an, dont une en pleine
 * saison des jours rouges.
 */
const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`date de test invalide: ${iso}`);
  return ms;
};

describe('jour Tempo (wrap de 6 h)', () => {
  it('le matin et la journée : le jour Tempo est la date locale', () => {
    expect(tempoDayKey(at('2026-08-03T06:00:00+02:00'))).toBe('2026-08-03');
    expect(tempoDayKey(at('2026-08-03T09:00:00+02:00'))).toBe('2026-08-03');
    expect(tempoDayKey(at('2026-08-03T23:59:59+02:00'))).toBe('2026-08-03');
  });

  it('entre minuit et 6 h : le jour Tempo est celui commencé la veille', () => {
    expect(tempoDayKey(at('2026-08-04T00:00:00+02:00'))).toBe('2026-08-03');
    expect(tempoDayKey(at('2026-08-04T03:00:00+02:00'))).toBe('2026-08-03');
    expect(tempoDayKey(at('2026-08-04T05:59:59+02:00'))).toBe('2026-08-03');
    // 6 h pile : le jour Tempo suivant commence.
    expect(tempoDayKey(at('2026-08-04T06:00:00+02:00'))).toBe('2026-08-04');
  });

  it('le wrap suit l’heure de Paris, pas UTC', () => {
    // 2026-01-15T00:30 à Paris (UTC+1) = 2026-01-14T23:30 UTC : un calcul en UTC
    // dirait « 14 janvier, 23 h 30 » donc jour Tempo du 14 — et se tromperait,
    // c'est bien le jour Tempo du 14 ici, mais pour la bonne raison.
    expect(tempoDayKey(at('2026-01-15T00:30:00+01:00'))).toBe('2026-01-14');
    // 2026-08-03T05:30 à Paris (UTC+2) = 03:30 UTC ; en revanche à 07:00 Paris
    // (05:00 UTC) un calcul UTC dirait « avant 6 h » et reculerait d'un jour.
    expect(tempoDayKey(at('2026-08-03T07:00:00+02:00'))).toBe('2026-08-03');
    expect(tempoDayKey(at('2026-08-03T05:30:00+02:00'))).toBe('2026-08-02');
  });

  it('addDays traverse les changements d’heure sans dériver', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-10-25', -1)).toBe('2026-10-24');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('période HP/HC', () => {
  it('HP de 6 h à 22 h, HC le reste, en été comme en hiver', () => {
    expect(periodeAt(at('2026-08-03T05:59:59+02:00'))).toBe('HC');
    expect(periodeAt(at('2026-08-03T06:00:00+02:00'))).toBe('HP');
    expect(periodeAt(at('2026-08-03T21:59:59+02:00'))).toBe('HP');
    expect(periodeAt(at('2026-08-03T22:00:00+02:00'))).toBe('HC');

    expect(periodeAt(at('2026-01-15T05:59:59+01:00'))).toBe('HC');
    expect(periodeAt(at('2026-01-15T06:00:00+01:00'))).toBe('HP');
    expect(periodeAt(at('2026-01-15T21:59:59+01:00'))).toBe('HP');
    expect(periodeAt(at('2026-01-15T22:00:00+01:00'))).toBe('HC');
  });

  it('même instant UTC, période différente selon la saison', () => {
    // 20:30 UTC = 22:30 à Paris l'été (HC) mais 21:30 l'hiver (HP).
    expect(periodeAt(at('2026-08-03T20:30:00Z'))).toBe('HC');
    expect(periodeAt(at('2026-01-15T20:30:00Z'))).toBe('HP');
  });
});

describe('frontières HP/HC', () => {
  it('vise la prochaine frontière, strictement postérieure', () => {
    expect(nextBoundary(at('2026-08-03T05:00:00+02:00'))).toBe(at('2026-08-03T06:00:00+02:00'));
    expect(nextBoundary(at('2026-08-03T09:00:00+02:00'))).toBe(at('2026-08-03T22:00:00+02:00'));
    expect(nextBoundary(at('2026-08-03T23:00:00+02:00'))).toBe(at('2026-08-04T06:00:00+02:00'));
    // Pile sur une frontière : c'est la suivante qu'on programme, sinon le
    // timer se rappellerait immédiatement en boucle.
    expect(nextBoundary(at('2026-08-03T22:00:00+02:00'))).toBe(at('2026-08-04T06:00:00+02:00'));
    expect(nextBoundary(at('2026-08-03T06:00:00+02:00'))).toBe(at('2026-08-03T22:00:00+02:00'));
  });

  it('nuit du passage à l’heure d’été : 22 h → 6 h ne dure que 6 h réelles', () => {
    const from = at('2026-03-28T23:00:00+01:00');
    const boundary = nextBoundary(from);
    expect(boundary).toBe(at('2026-03-29T06:00:00+02:00'));
    // 7 h en temps local, 6 h en temps réel : c'est la seconde qui pilote le timer.
    expect(boundary - from).toBe(6 * 3_600_000);
  });

  it('nuit du passage à l’heure d’hiver : 22 h → 6 h dure 8 h réelles', () => {
    const from = at('2026-10-24T23:00:00+02:00');
    const boundary = nextBoundary(from);
    expect(boundary).toBe(at('2026-10-25T06:00:00+01:00'));
    expect(boundary - from).toBe(8 * 3_600_000);
  });
});

describe('conversions', () => {
  it('parisEpochOf place 6 h à la bonne heure des deux côtés du changement', () => {
    expect(parisEpochOf('2026-03-28', 6)).toBe(at('2026-03-28T06:00:00+01:00'));
    expect(parisEpochOf('2026-03-29', 6)).toBe(at('2026-03-29T06:00:00+02:00'));
    expect(parisEpochOf('2026-10-25', 6)).toBe(at('2026-10-25T06:00:00+01:00'));
    expect(parisEpochOf('2026-08-03', 22)).toBe(at('2026-08-03T22:00:00+02:00'));
  });

  it('parisIso rend l’offset local, jamais un offset codé en dur', () => {
    expect(parisIso(at('2026-08-03T06:00:00+02:00'))).toBe('2026-08-03T06:00:00+02:00');
    expect(parisIso(at('2026-01-15T06:00:00+01:00'))).toBe('2026-01-15T06:00:00+01:00');
    // Entrée en UTC, sortie en heure de Paris : c'est ce que RTE attend.
    expect(parisIso(at('2026-08-03T04:00:00Z'))).toBe('2026-08-03T06:00:00+02:00');
  });

  it('dayKeyOfPeriodStart nomme le jour Tempo quelle que soit la convention', () => {
    // Convention documentée : début de période à 6 h locale.
    expect(dayKeyOfPeriodStart('2026-08-03T06:00:00+02:00')).toBe('2026-08-03');
    // Convention « minuit » rencontrée sur d'autres jeux de données ouverts :
    // un wrap la ferait reculer d'un jour, c'est-à-dire mentir.
    expect(dayKeyOfPeriodStart('2026-08-03T00:00:00+02:00')).toBe('2026-08-03');
    // Servi en UTC : on repasse par le fuseau local, donc bonne date.
    expect(dayKeyOfPeriodStart('2026-08-03T04:00:00Z')).toBe('2026-08-03');
    expect(dayKeyOfPeriodStart('2026-01-15T05:00:00Z')).toBe('2026-01-15');
  });

  it('rejette une date illisible plutôt que d’inventer un jour', () => {
    expect(() => dayKeyOfPeriodStart('demain matin')).toThrow(/date ISO invalide/);
    expect(() => addDays('pas-une-date', 1)).toThrow(/date invalide/);
  });
});
