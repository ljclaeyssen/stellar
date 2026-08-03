import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSseDecoder } from './api.js';
import { HueDevice, HueEvent, HueLight, HueResourceUpdate, HueRoom } from './clipv2.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/clipv2/${name}`, import.meta.url), 'utf8'));

describe('createSseDecoder', () => {
  const collect = (chunks: string[]): string[] => {
    const seen: string[] = [];
    const feed = createSseDecoder((data) => seen.push(data));
    for (const chunk of chunks) feed(chunk);
    return seen;
  };

  it('n’émet qu’à la ligne vide et ignore commentaires et champ id', () => {
    expect(collect([': hi\n\n', 'id: 1\ndata: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('recolle un événement coupé n’importe où dans le flux TCP', () => {
    // Frontière au milieu du JSON, puis au milieu du séparateur de trame.
    expect(collect(['id: 1\ndata: {"a"', ':1}\n', '\nid: 2\ndata: {"b":2}\n\n'])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('concatène les lignes data multiples et supporte les CRLF', () => {
    expect(collect(['data: un\r\ndata: deux\r\n\r\n'])).toEqual(['un\ndeux']);
  });

  it('n’émet rien tant que la trame est incomplète', () => {
    expect(collect(['id: 1\ndata: {"a":1}\n'])).toEqual([]);
  });
});

describe('contrats CLIP v2 contre les fixtures', () => {
  it('parse l’événement d’exemple du flux SSE', () => {
    const raw = fixture('event-light-update.json');
    expect(Array.isArray(raw)).toBe(true);
    const event = HueEvent.parse((raw as unknown[])[0]);
    expect(event.type).toBe('update');

    const update = HueResourceUpdate.parse(event.data[0]);
    expect(update).toMatchObject({
      id: '1f7a2b3c-4d5e-4f60-8a91-b2c3d4e5f601',
      type: 'light',
      on: { on: true },
      dimming: { brightness: 80 },
    });
  });

  it('parse l’inventaire d’exemple, prise comprise', () => {
    const lights = (fixture('lights.json') as { data: unknown[] }).data.map((light) =>
      HueLight.parse(light),
    );
    expect(lights).toHaveLength(3);
    expect(lights.map((light) => light.metadata.archetype)).toContain('plug');

    const rooms = (fixture('rooms.json') as { data: unknown[] }).data.map((room) =>
      HueRoom.parse(room),
    );
    const devices = (fixture('devices.json') as { data: unknown[] }).data.map((device) =>
      HueDevice.parse(device),
    );
    // Cohérence des fixtures entre elles : chaque owner existe et est rangé.
    const deviceIds = new Set(devices.map((device) => device.id));
    const placed = new Set(rooms.flatMap((room) => room.children.map((child) => child.rid)));
    for (const light of lights) {
      expect(deviceIds.has(light.owner.rid)).toBe(true);
      expect(placed.has(light.owner.rid)).toBe(true);
    }
  });
});
