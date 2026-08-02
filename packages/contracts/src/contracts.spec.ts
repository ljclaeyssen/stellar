import { describe, expect, it } from 'vitest';
import {
  Ack,
  Command,
  Manifest,
  TempoValue,
  matchTopic,
  matchesSelector,
  parseEntity,
  parseStateTopic,
  safeParseEntity,
  stateTopic,
  toJsonSchema,
  type Entity,
} from './index.js';

// Exemple de la spec §6
const climSalon = {
  id: 'clim_salon',
  driver: 'midea',
  kind: 'climate',
  room: 'salon',
  value: { power: true, mode: 'heat', targetTemp: 20.5, indoorTemp: 19.8, fan: 'auto' },
  ts: '2026-11-14T06:12:03Z',
};

describe('Entity + value par kind', () => {
  it('accepte le payload climate de la spec', () => {
    const entity = parseEntity(climSalon);
    expect(entity.kind).toBe('climate');
    expect(entity.room).toBe('salon');
  });

  it('rejette un value invalide pour le kind', () => {
    const bad = { ...climSalon, value: { power: true, mode: 'grille-pain', targetTemp: 20 } };
    const result = safeParseEntity(bad);
    expect(result.success).toBe(false);
  });

  it('rejette un kind inconnu', () => {
    expect(safeParseEntity({ ...climSalon, kind: 'toaster' }).success).toBe(false);
  });

  it('rejette un ts non ISO 8601', () => {
    expect(safeParseEntity({ ...climSalon, ts: 'hier soir' }).success).toBe(false);
  });

  it('accepte temperature=number et rejette temperature=string', () => {
    const temp = {
      id: 'temp_chambre',
      driver: 'z2m',
      kind: 'temperature',
      room: 'chambre',
      value: 19.2,
      unit: '°C',
      ts: '2026-11-14T06:12:03Z',
    };
    expect(safeParseEntity(temp).success).toBe(true);
    expect(safeParseEntity({ ...temp, value: '19.2' }).success).toBe(false);
  });

  it('accepte tempo et rejette une couleur inconnue', () => {
    expect(
      TempoValue.safeParse({ couleurJour: 'rouge', couleurDemain: 'inconnue', periode: 'HP' })
        .success,
    ).toBe(true);
    expect(
      TempoValue.safeParse({ couleurJour: 'vert', couleurDemain: 'bleu', periode: 'HP' }).success,
    ).toBe(false);
  });
});

describe('Command / Ack', () => {
  it('accepte la commande de la spec', () => {
    const cmd = Command.parse({
      id: '0b8e7c5e-1d2f-4a3b-9c8d-7e6f5a4b3c2d',
      target: 'clim_salon',
      action: 'set',
      params: { power: true, mode: 'heat', targetTemp: 21 },
      issuedBy: 'core',
      ts: '2026-11-14T06:12:04Z',
    });
    expect(cmd.action).toBe('set');
  });

  it('rejette un issuedBy hors enum et un id non uuid', () => {
    const base = {
      id: '0b8e7c5e-1d2f-4a3b-9c8d-7e6f5a4b3c2d',
      target: 'clim_salon',
      action: 'set',
      params: {},
      issuedBy: 'core',
      ts: '2026-11-14T06:12:04Z',
    };
    expect(Command.safeParse({ ...base, issuedBy: 'alexa' }).success).toBe(false);
    expect(Command.safeParse({ ...base, id: 'c1f0' }).success).toBe(false);
  });

  it('valide un Ack timeout', () => {
    expect(
      Ack.safeParse({
        commandId: '0b8e7c5e-1d2f-4a3b-9c8d-7e6f5a4b3c2d',
        status: 'timeout',
        reason: 'no ack after 5000ms',
      }).success,
    ).toBe(true);
  });
});

describe('Manifest', () => {
  it('valide un manifeste minimal', () => {
    const manifest = Manifest.parse({
      driver: 'fake',
      version: '0.1.0',
      entities: [{ id: 'clim_salon', kind: 'climate', room: 'salon' }],
      commands: [{ action: 'set', paramsSchema: toJsonSchema(TempoValue) }],
    });
    expect(manifest.entities).toHaveLength(1);
  });
});

describe('topics', () => {
  it('construit et parse les topics state', () => {
    expect(stateTopic('midea', 'clim_salon')).toBe('home/state/midea/clim_salon');
    expect(parseStateTopic('home/state/midea/clim_salon')).toEqual({
      driver: 'midea',
      entityId: 'clim_salon',
    });
    expect(parseStateTopic('home/cmd/midea/clim_salon')).toBeNull();
    expect(parseStateTopic('home/state/midea')).toBeNull();
  });

  it('matche les wildcards MQTT', () => {
    expect(matchTopic('home/state/#', 'home/state/midea/clim_salon')).toBe(true);
    expect(matchTopic('home/state/+/clim_salon', 'home/state/midea/clim_salon')).toBe(true);
    expect(matchTopic('home/state/+', 'home/state/midea/clim_salon')).toBe(false);
    expect(matchTopic('home/event/#', 'home/state/midea/clim_salon')).toBe(false);
  });
});

describe('selector', () => {
  const entity = parseEntity(climSalon) satisfies Entity;
  it('matche par kind + room, jamais par nom de driver requis', () => {
    expect(matchesSelector(entity, { kind: 'climate', room: 'salon' })).toBe(true);
    expect(matchesSelector(entity, { kind: 'climate', room: 'chambre' })).toBe(false);
    expect(matchesSelector(entity, {})).toBe(true);
    expect(matchesSelector(entity, { id: 'clim_salon' })).toBe(true);
  });
});

describe('json-schema', () => {
  it('exporte un JSON Schema exploitable', () => {
    const schema = toJsonSchema(Command);
    expect(schema).toHaveProperty('$schema');
    expect(JSON.stringify(schema)).toContain('issuedBy');
  });
});
