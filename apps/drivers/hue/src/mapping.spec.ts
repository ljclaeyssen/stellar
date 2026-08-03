import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@stellar/bus';
import type { HueDevice, HueLight, HueRoom } from './clipv2.js';
import { buildInventory, mergeUpdate, slug, toValue } from './mapping.js';

const warn = vi.fn();
const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
};

const light = (over: {
  id: string;
  name: string;
  device: string;
  archetype?: string;
  on?: boolean;
  brightness?: number;
  mirek?: number | null;
}): HueLight => ({
  id: over.id,
  owner: { rid: over.device, rtype: 'device' },
  metadata: { name: over.name, ...(over.archetype ? { archetype: over.archetype } : {}) },
  on: { on: over.on ?? false },
  ...(over.brightness === undefined ? {} : { dimming: { brightness: over.brightness } }),
  ...(over.mirek === undefined ? {} : { color_temperature: { mirek: over.mirek } }),
  type: 'light',
});

const device = (id: string, name: string, archetype?: string): HueDevice => ({
  id,
  metadata: { name, ...(archetype ? { archetype } : {}) },
  services: [],
  type: 'device',
});

const room = (id: string, name: string, deviceIds: string[]): HueRoom => ({
  id,
  children: deviceIds.map((rid) => ({ rid, rtype: 'device' })),
  metadata: { name },
  type: 'room',
});

describe('slug', () => {
  it('translitère les accents et normalise en snake_case', () => {
    expect(slug('Chambre bébé')).toBe('chambre_bebe');
    expect(slug('Canapé')).toBe('canape');
    expect(slug('Prise TV')).toBe('prise_tv');
    expect(slug('Salle d’eau')).toBe('salle_d_eau');
    expect(slug('Küche #2')).toBe('kuche_2');
  });

  it('ne laisse ni séparateur en bord ni chaîne vide', () => {
    expect(slug('  -- Bureau --  ')).toBe('bureau');
    expect(slug('***')).toBe('sans_nom');
  });
});

describe('buildInventory', () => {
  it('nomme les entités <type>_<room>_<nom> et range chaque lampe par son device', () => {
    const entities = buildInventory({
      lights: [
        light({ id: 'l1', name: 'Canapé', device: 'd1' }),
        light({ id: 'l2', name: 'Chevet', device: 'd2' }),
      ],
      devices: [device('d1', 'Canapé'), device('d2', 'Chevet')],
      rooms: [room('r1', 'Salon', ['d1']), room('r2', 'Chambre bébé', ['d2'])],
      logger,
    });
    expect(entities.map((e) => e.entityId)).toEqual([
      'light_salon_canape',
      'light_chambre_bebe_chevet',
    ]);
    expect(entities.map((e) => e.room)).toEqual(['salon', 'chambre_bebe']);
    expect(entities.every((e) => e.kind === 'light')).toBe(true);
  });

  it('sort une prise en kind plug, sans le préfixe de pièce (spec §6 : plug_tv)', () => {
    const entities = buildInventory({
      lights: [light({ id: 'l1', name: 'Prise TV', device: 'd1', archetype: 'plug', on: true })],
      devices: [device('d1', 'Prise TV', 'plug')],
      rooms: [room('r1', 'Salon', ['d1'])],
      logger,
    });
    expect(entities[0]).toMatchObject({
      entityId: 'plug_prise_tv',
      kind: 'plug',
      room: 'salon',
      value: { on: true },
    });
  });

  it('retombe sur l’archetype du device quand le service n’en porte pas', () => {
    const entities = buildInventory({
      lights: [light({ id: 'l1', name: 'Prise TV', device: 'd1' })],
      devices: [device('d1', 'Prise TV', 'plug')],
      rooms: [],
      logger,
    });
    expect(entities[0]?.kind).toBe('plug');
  });

  it('une lampe sans room garde un id sans pièce et aucun room', () => {
    const entities = buildInventory({
      lights: [light({ id: 'l1', name: 'Guirlande', device: 'd1' })],
      devices: [device('d1', 'Guirlande')],
      rooms: [room('r1', 'Salon', ['d-autre'])],
      logger,
    });
    expect(entities[0]?.entityId).toBe('light_guirlande');
    expect(entities[0]?.room).toBeUndefined();
  });

  it('désambiguïse les collisions de slug par un suffixe numéroté et prévient', () => {
    const entities = buildInventory({
      lights: [
        light({ id: 'l1', name: 'Spot', device: 'd1' }),
        light({ id: 'l2', name: 'spot', device: 'd2' }),
        light({ id: 'l3', name: 'SPOT', device: 'd3' }),
      ],
      devices: [device('d1', 'Spot'), device('d2', 'spot'), device('d3', 'SPOT')],
      rooms: [room('r1', 'Cuisine', ['d1', 'd2', 'd3'])],
      logger,
    });
    expect(entities.map((e) => e.entityId)).toEqual([
      'light_cuisine_spot',
      'light_cuisine_spot_2',
      'light_cuisine_spot_3',
    ]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('toValue / mergeUpdate', () => {
  it('traduit dimming et color_temperature, ignore un mirek null', () => {
    expect(
      toValue(light({ id: 'l1', name: 'A', device: 'd1', brightness: 62.4, mirek: 366 }), 'light'),
    ).toEqual({ on: false, brightness: 62.4, color: { mirek: 366 } });
    expect(toValue(light({ id: 'l1', name: 'A', device: 'd1', mirek: null }), 'light')).toEqual({
      on: false,
    });
  });

  it('une prise ne retient que on', () => {
    expect(
      toValue(light({ id: 'l1', name: 'P', device: 'd1', brightness: 50, on: true }), 'plug'),
    ).toEqual({
      on: true,
    });
  });

  it('fusionne un événement partiel sans perdre les champs absents', () => {
    const current = { on: false, brightness: 62.4, color: { mirek: 366 } };
    expect(mergeUpdate(current, { id: 'l1', on: { on: true } }, 'light')).toEqual({
      on: true,
      brightness: 62.4,
      color: { mirek: 366 },
    });
    expect(mergeUpdate(current, { id: 'l1', dimming: { brightness: 10 } }, 'light')).toEqual({
      on: false,
      brightness: 10,
      color: { mirek: 366 },
    });
  });
});
