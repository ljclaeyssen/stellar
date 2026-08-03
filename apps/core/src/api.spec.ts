import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Entity, Health, Manifest } from '@stellar/contracts';
import { matchesSelector } from '@stellar/contracts';
import { parseJournalQuery, startApiServer, type ApiServer } from './api.js';
import { createJournal, type Journal } from './journal.js';
import type { Mirror } from './mirror.js';

/**
 * Le gros de l'API se teste par appel en process (cf. core.spec.ts) : ici, un seul
 * aller-retour réseau par transport, pour prouver que HTTP et WebSocket servent
 * bien le même routeur sur le même port, et que la fermeture est propre.
 */

const entity = (id: string, kind: Entity['kind'], room: string, value: unknown): Entity => ({
  id,
  driver: 'fake',
  kind,
  room,
  value,
  ts: '2026-08-03T06:00:00.000Z',
});

const entities: Entity[] = [
  entity('temp_salon', 'temperature', 'salon', 19.5),
  entity('presence_salon', 'presence', 'salon', true),
];

const mirror: Mirror = {
  getStates: (selector = {}) => entities.filter((e) => matchesSelector(e, selector)),
  getState: (id) => entities.find((e) => e.id === id),
  getHealth: () => new Map<string, Health>([['fake', { status: 'online', ts: entities[0]!.ts }]]),
  getManifests: () => new Map<string, Manifest>(),
};

interface TrpcResponse<T> {
  result?: { data: T };
  error?: { message: string };
}

describe('API tRPC (HTTP + WebSocket)', () => {
  let journal: Journal;
  let api: ApiServer;

  beforeAll(async () => {
    journal = createJournal({ path: ':memory:' });
    journal.append({
      topic: 'home/state/fake/temp_salon',
      payload: '19.5',
      entityId: 'temp_salon',
    });
    api = await startApiServer({ mirror, journal, port: 0 });
  });

  afterAll(async () => {
    await api.close();
    journal.close();
  });

  it('répond en HTTP à getStates avec un sélecteur', async () => {
    const input = encodeURIComponent(JSON.stringify({ kind: 'temperature' }));
    const response = await fetch(`http://127.0.0.1:${api.port}/getStates?input=${input}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as TrpcResponse<Entity[]>;
    expect(body.result?.data.map((e) => e.id)).toEqual(['temp_salon']);
  });

  it('sert le MÊME routeur en WebSocket sur le même port', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${api.port}`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const answer = new Promise<TrpcResponse<Entity[]>>((resolve) => {
      socket.once('message', (raw: Buffer) =>
        resolve(JSON.parse(raw.toString()) as TrpcResponse<Entity[]>),
      );
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'query',
        params: { path: 'getStates', input: { room: 'salon' } },
      }),
    );

    const body = await answer;
    expect(body.result?.data.map((e) => e.id)).toEqual(['temp_salon', 'presence_salon']);
    socket.close();
  });

  it('renvoie une erreur HTTP 400 sur une entrée invalide', async () => {
    const input = encodeURIComponent(JSON.stringify({ limit: -1 }));
    const response = await fetch(`http://127.0.0.1:${api.port}/journal.query?input=${input}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as TrpcResponse<never>;
    expect(body.error?.message).toMatch(/limit/);
  });
});

describe('parseJournalQuery', () => {
  it('accepte une entrée vide et normalise les filtres', () => {
    expect(parseJournalQuery(undefined)).toEqual({});
    expect(
      parseJournalQuery({
        entityId: 'temp_salon',
        kind: 'temperature',
        driver: 'fake',
        from: '2026-08-03T00:00:00.000Z',
        to: '2026-08-03T23:59:59.000Z',
        limit: 10,
        order: 'asc',
      }),
    ).toEqual({
      entityId: 'temp_salon',
      kind: 'temperature',
      driver: 'fake',
      from: '2026-08-03T00:00:00.000Z',
      to: '2026-08-03T23:59:59.000Z',
      limit: 10,
      order: 'asc',
    });
  });

  it('rejette les entrées absurdes', () => {
    expect(() => parseJournalQuery('nope')).toThrow(/objet/);
    expect(() => parseJournalQuery({ limit: 1.5 })).toThrow(/limit/);
    expect(() => parseJournalQuery({ limit: 99_999 })).toThrow(/limit/);
    expect(() => parseJournalQuery({ entityId: '' })).toThrow(/entityId/);
    expect(() => parseJournalQuery({ to: '3 août' })).toThrow(/ISO 8601/);
  });
});
