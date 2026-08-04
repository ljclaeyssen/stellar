import { describe, expect, it, vi } from 'vitest';
import type { JournalQuery, JournalRow } from '../journal.js';
import { createOccupancyProfileCache, type OccupancyJournal } from './profile-cache.js';

/**
 * CACHE DU PROFIL D'OCCUPATION (P9).
 *
 * L'enjeu tient en une phrase : la régulation tourne au moins une fois par minute
 * et le profil coûte 28 jours de journal. Le test compte donc les appels à
 * `query` — c'est la seule chose qui compte vraiment ici — sur une horloge
 * injectée, sans SQLite ni timers.
 */

const HEURE = 3_600_000;
const MINUTE = 60_000;
/** 2026-01-15 00:00 heure locale (Europe/Paris). */
const DEPART = Date.UTC(2026, 0, 14, 23, 0);

interface Espion extends OccupancyJournal {
  readonly calls: JournalQuery[];
}

function journalEspion(rows: JournalRow[] = [], onQuery?: () => void): Espion {
  const calls: JournalQuery[] = [];
  return {
    calls,
    query(query = {}) {
      calls.push(query);
      onQuery?.();
      return rows;
    },
  };
}

const presenceRow = (id: number, ts: number, room: string, value: boolean): JournalRow => ({
  id,
  ts: new Date(ts).toISOString(),
  topic: 'home/state/fakepercepts/presence_salon',
  driver: 'fakepercepts',
  entityId: 'presence_salon',
  kind: 'presence',
  payload: JSON.stringify({
    id: 'presence_salon',
    driver: 'fakepercepts',
    kind: 'presence',
    room,
    value,
    ts: new Date(ts).toISOString(),
  }),
  issuedBy: null,
});

describe('cache du profil d’occupation', () => {
  it('ne relit le journal qu’une fois par heure, quel que soit le nombre de tours', () => {
    const journal = journalEspion([presenceRow(1, DEPART - HEURE, 'salon', true)]);
    const cache = createOccupancyProfileCache({ journal, timezone: 'Europe/Paris' });

    // Soixante tours de régulation dans l'heure : une seule lecture.
    for (let minute = 0; minute < 60; minute += 1) cache.get(DEPART + minute * MINUTE);
    expect(journal.calls).toHaveLength(1);
    expect(cache.builds).toBe(1);

    // Pile une heure plus tard : l'échéance tombe.
    cache.get(DEPART + HEURE);
    expect(journal.calls).toHaveLength(2);

    for (let minute = 1; minute < 60; minute += 1) cache.get(DEPART + HEURE + minute * MINUTE);
    expect(journal.calls).toHaveLength(2);
    expect(cache.builds).toBe(2);
  });

  it('rend le même objet de profil entre deux reconstructions', () => {
    const journal = journalEspion([presenceRow(1, DEPART - HEURE, 'salon', true)]);
    const cache = createOccupancyProfileCache({ journal, timezone: 'Europe/Paris' });

    const premier = cache.get(DEPART);
    expect(premier).toBeDefined();
    expect(cache.get(DEPART + 30 * MINUTE)).toBe(premier);
    expect(cache.get(DEPART + HEURE)).not.toBe(premier);
  });

  it('interroge le journal sur le seul kind utile et sur la fenêtre demandée', () => {
    const journal = journalEspion();
    const cache = createOccupancyProfileCache({
      journal,
      timezone: 'Europe/Paris',
      windowDays: 14,
    });

    cache.get(DEPART);

    expect(journal.calls[0]).toMatchObject({
      kind: 'presence',
      from: new Date(DEPART - 14 * 86_400_000).toISOString(),
      // Les lignes les plus RÉCENTES : un plafond atteint doit raccourcir la
      // fenêtre, jamais la décaler dans le passé.
      order: 'desc',
    });
    expect(cache.get(DEPART)?.windowDays).toBe(14);
  });

  it('respecte un intervalle de rafraîchissement personnalisé', () => {
    const journal = journalEspion();
    const cache = createOccupancyProfileCache({
      journal,
      timezone: 'Europe/Paris',
      refreshIntervalMs: 15 * MINUTE,
    });

    cache.get(DEPART);
    cache.get(DEPART + 14 * MINUTE);
    expect(journal.calls).toHaveLength(1);
    cache.get(DEPART + 15 * MINUTE);
    expect(journal.calls).toHaveLength(2);
  });

  it('survit à un journal en erreur : ancien profil conservé, une plainte par heure', () => {
    let casse = false;
    const journal = journalEspion([presenceRow(1, DEPART - HEURE, 'salon', true)], () => {
      if (casse) throw new Error('database is locked');
    });
    const warnings: string[] = [];
    const cache = createOccupancyProfileCache({
      journal,
      timezone: 'Europe/Paris',
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg) => warnings.push(msg),
        error: () => undefined,
      },
    });

    const bon = cache.get(DEPART);
    expect(bon).toBeDefined();

    casse = true;
    // Une heure plus tard la reconstruction échoue : le profil précédent tient.
    expect(cache.get(DEPART + HEURE)).toBe(bon);
    expect(warnings).toEqual(['profil d’occupation non reconstruit']);

    // Et surtout : on ne réessaie pas à chaque tour (sinon le log déborde).
    for (let minute = 1; minute < 60; minute += 1) cache.get(DEPART + HEURE + minute * MINUTE);
    expect(journal.calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it('rend `undefined` tant qu’aucune construction n’a abouti', () => {
    const journal = journalEspion([], () => {
      throw new Error('journal absent');
    });
    const cache = createOccupancyProfileCache({ journal, timezone: 'Europe/Paris' });
    expect(cache.get(DEPART)).toBeUndefined();
  });

  it('signale une lecture tronquée par le plafond de lignes', () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      presenceRow(index + 1, DEPART - HEURE, 'salon', true),
    );
    const warn = vi.fn();
    const cache = createOccupancyProfileCache({
      journal: journalEspion(rows),
      timezone: 'Europe/Paris',
      maxRows: 3,
      logger: { debug: () => undefined, info: () => undefined, warn, error: () => undefined },
    });

    cache.get(DEPART);
    expect(warn).toHaveBeenCalledWith(
      'profil d’occupation tronqué : plafond de lignes atteint',
      expect.objectContaining({ maxRows: 3 }),
    );
  });
});
