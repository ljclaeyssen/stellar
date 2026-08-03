import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createJournal,
  journalEntryFromMessage,
  JOURNAL_DEFAULT_LIMIT,
  type Journal,
} from './journal.js';

/** Horodatages fixes : les tests de période doivent être lisibles. */
const T = (minute: number): string => new Date(Date.UTC(2026, 7, 3, 6, minute, 0)).toISOString();

describe('journal SQLite', () => {
  let journal: Journal;

  beforeEach(() => {
    journal = createJournal({ path: ':memory:' });
  });

  afterEach(() => {
    journal.close();
  });

  const appendState = (entityId: string, minute: number, extra: Record<string, unknown> = {}) =>
    journal.append({
      ts: T(minute),
      topic: `home/state/fake/${entityId}`,
      driver: 'fake',
      entityId,
      kind: 'temperature',
      payload: JSON.stringify({ id: entityId, value: minute, ...extra }),
    });

  it('insère et relit une ligne complète', () => {
    const id = journal.append({
      ts: T(0),
      topic: 'home/cmd/fake/clim_salon',
      driver: 'fake',
      entityId: 'clim_salon',
      kind: null,
      payload: '{"action":"set"}',
      issuedBy: 'core',
    });
    expect(id).toBe(1);

    const rows = journal.query();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      ts: T(0),
      topic: 'home/cmd/fake/clim_salon',
      driver: 'fake',
      entityId: 'clim_salon',
      kind: null,
      payload: '{"action":"set"}',
      issuedBy: 'core',
    });
  });

  it('filtre par entité, par kind et par driver', () => {
    appendState('temp_salon', 1);
    appendState('temp_chambre', 2);
    journal.append({
      ts: T(3),
      topic: 'home/state/autre/presence_salon',
      driver: 'autre',
      entityId: 'presence_salon',
      kind: 'presence',
      payload: 'true',
    });

    expect(journal.query({ entityId: 'temp_salon' })).toHaveLength(1);
    expect(journal.query({ kind: 'temperature' })).toHaveLength(2);
    expect(journal.query({ driver: 'autre' })).toHaveLength(1);
    expect(journal.query({ driver: 'autre', kind: 'temperature' })).toHaveLength(0);
  });

  it('filtre par période (bornes incluses)', () => {
    for (const minute of [1, 2, 3, 4, 5]) appendState('temp_salon', minute);

    expect(journal.query({ from: T(2), to: T(4) })).toHaveLength(3);
    expect(journal.query({ from: T(4) })).toHaveLength(2);
    expect(journal.query({ to: T(1) })).toHaveLength(1);
    expect(journal.query({ from: T(6) })).toHaveLength(0);
  });

  it('applique limit et order (desc par défaut)', () => {
    for (const minute of [1, 2, 3]) appendState('temp_salon', minute);

    expect(journal.query().map((r) => r.ts)).toEqual([T(3), T(2), T(1)]);
    expect(journal.query({ order: 'asc' }).map((r) => r.ts)).toEqual([T(1), T(2), T(3)]);
    expect(journal.query({ limit: 2 }).map((r) => r.ts)).toEqual([T(3), T(2)]);
    expect(journal.query({ limit: 2, order: 'asc' }).map((r) => r.ts)).toEqual([T(1), T(2)]);
  });

  it('départage deux lignes de même ts par ordre d’insertion', () => {
    const first = appendState('temp_salon', 1);
    const second = appendState('temp_salon', 1);

    expect(journal.query({ order: 'asc' }).map((r) => r.id)).toEqual([first, second]);
    expect(journal.query().map((r) => r.id)).toEqual([second, first]);
  });

  it('plafonne à 100 lignes par défaut', () => {
    for (let i = 0; i < JOURNAL_DEFAULT_LIMIT + 20; i++) appendState('temp_salon', 0);
    expect(journal.count()).toBe(JOURNAL_DEFAULT_LIMIT + 20);
    expect(journal.query()).toHaveLength(JOURNAL_DEFAULT_LIMIT);
    expect(journal.query({ limit: 200 })).toHaveLength(JOURNAL_DEFAULT_LIMIT + 20);
  });

  it('compte de façon strictement croissante', () => {
    expect(journal.count()).toBe(0);
    appendState('temp_salon', 1);
    expect(journal.count()).toBe(1);
    appendState('temp_salon', 1);
    expect(journal.count()).toBe(2);
  });

  it('journalise un payload vide (effacement du retained)', () => {
    journal.append({
      ts: T(1),
      topic: 'home/state/fake/temp_garage',
      driver: 'fake',
      entityId: 'temp_garage',
      payload: '',
    });

    const [row] = journal.query({ entityId: 'temp_garage' });
    expect(row?.payload).toBe('');
    expect(row?.kind).toBeNull();
  });

  it('horodate à maintenant quand `ts` est omis', () => {
    const before = Date.now();
    journal.append({ topic: 'home/health/fake', payload: '{"status":"online"}' });
    const [row] = journal.query();
    expect(Date.parse(row?.ts ?? '')).toBeGreaterThanOrEqual(before);
  });
});

describe('journal sur fichier', () => {
  it('crée le dossier manquant, persiste et se relit après fermeture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stellar-journal-'));
    // Le dossier du fichier n'existe pas encore : c'est le cas du premier
    // démarrage (CORE_DB_PATH = ./data/journal.db).
    const path = join(dir, 'data', 'journal.db');

    const first = createJournal({ path });
    first.append({ ts: T(1), topic: 'home/state/fake/temp_salon', payload: '19.5' });
    first.close();
    expect(existsSync(path)).toBe(true);

    const second = createJournal({ path });
    expect(second.count()).toBe(1);
    expect(second.query()[0]?.payload).toBe('19.5');
    second.close();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('journalEntryFromMessage', () => {
  const ts = T(0);

  it('extrait driver/entityId/kind d’un state', () => {
    const payload = JSON.stringify({
      id: 'temp_salon',
      driver: 'fake',
      kind: 'temperature',
      value: 19.5,
      ts,
    });
    expect(journalEntryFromMessage('home/state/fake/temp_salon', payload, ts)).toEqual({
      ts,
      topic: 'home/state/fake/temp_salon',
      payload,
      driver: 'fake',
      entityId: 'temp_salon',
      kind: 'temperature',
    });
  });

  it('extrait la cible et l’émetteur d’une commande', () => {
    const payload = JSON.stringify({
      id: 'c1',
      target: 'clim_salon',
      action: 'set',
      issuedBy: 'agent',
    });
    const entry = journalEntryFromMessage('home/cmd/fake/clim_salon', payload, ts);
    expect(entry.driver).toBe('fake');
    expect(entry.entityId).toBe('clim_salon');
    expect(entry.issuedBy).toBe('agent');
    expect(entry.kind).toBeUndefined();
  });

  it('extrait le driver des topics event, health et discovery', () => {
    expect(
      journalEntryFromMessage('home/event/core/stale_alert', '{"driver":"core"}', ts).driver,
    ).toBe('core');
    expect(journalEntryFromMessage('home/health/fake', '{"status":"online"}', ts).driver).toBe(
      'fake',
    );
    expect(journalEntryFromMessage('home/discovery/fake', '{"driver":"fake"}', ts).driver).toBe(
      'fake',
    );
  });

  it('journalise quand même un ack (aucun champ indexable) et un JSON cassé', () => {
    const ack = journalEntryFromMessage('home/ack/c1', '{"commandId":"c1","status":"ok"}', ts);
    expect(ack.payload).toContain('"status":"ok"');
    expect(ack.entityId).toBeUndefined();

    const casse = journalEntryFromMessage('home/state/fake/x', '{ pas du json', ts);
    expect(casse.payload).toBe('{ pas du json');
    expect(casse.kind).toBeUndefined();
    expect(casse.driver).toBeUndefined();
  });

  it('retombe sur le topic quand le payload n’a pas les champs attendus', () => {
    const entry = journalEntryFromMessage('home/state/fake/temp_salon', '{"value":1}', ts);
    expect(entry.driver).toBe('fake');
    expect(entry.entityId).toBe('temp_salon');
    expect(entry.kind).toBeNull();
  });
});
