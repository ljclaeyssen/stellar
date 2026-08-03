import { describe, expect, it } from 'vitest';
import {
  Ack,
  BusEvent,
  ClimateValue,
  Command,
  Health,
  HumidityValue,
  LightValue,
  Manifest,
  PowerValue,
  TempoValue,
  isKind,
  matchTopic,
  matchesSelector,
  parseEntity,
  parseStateTopic,
  safeParseEntity,
  stateTopic,
  toJsonSchema,
  valueOf,
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

  it('remappe le path des issues du value sous ["value", …]', () => {
    const bad = { ...climSalon, value: { ...climSalon.value, mode: 'grille-pain' } };
    const result = safeParseEntity(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path);
    expect(paths).toContainEqual(['value', 'mode']);
    expect(result.error.issues[0]?.message).toContain("kind 'climate'");
  });

  it('remappe aussi un value scalaire sur le path ["value"]', () => {
    const result = safeParseEntity({
      id: 'temp_chambre',
      driver: 'z2m',
      kind: 'temperature',
      value: 'dix-neuf',
      ts: '2026-11-14T06:12:03Z',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['value']);
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

  it('borne temperature aux valeurs physiquement plausibles', () => {
    const temp = {
      id: 'temp_chambre',
      driver: 'z2m',
      kind: 'temperature',
      value: 19.2,
      ts: '2026-11-14T06:12:03Z',
    };
    expect(safeParseEntity({ ...temp, value: -50 }).success).toBe(true);
    expect(safeParseEntity({ ...temp, value: 80 }).success).toBe(true);
    expect(safeParseEntity({ ...temp, value: -273.15 }).success).toBe(false);
    expect(safeParseEntity({ ...temp, value: 1_000 }).success).toBe(false);
  });

  it('borne humidity à 0–100', () => {
    expect(HumidityValue.safeParse(0).success).toBe(true);
    expect(HumidityValue.safeParse(100).success).toBe(true);
    expect(HumidityValue.safeParse(-1).success).toBe(false);
    expect(HumidityValue.safeParse(101).success).toBe(false);
  });

  it('borne light.brightness à 0–100 et laisse brightness optionnel', () => {
    expect(LightValue.safeParse({ on: true }).success).toBe(true);
    expect(LightValue.safeParse({ on: true, brightness: 100 }).success).toBe(true);
    expect(LightValue.safeParse({ on: true, brightness: 101 }).success).toBe(false);
    expect(LightValue.safeParse({ on: true, brightness: -1 }).success).toBe(false);
  });

  it('conserve les champs supplémentaires de power (passthrough P5)', () => {
    const parsed = PowerValue.parse({ va: 1234, indexBase: 42, indexHC: 7, papp: 1234 });
    expect(parsed).toMatchObject({ va: 1234, indexHC: 7, papp: 1234 });
    expect(PowerValue.safeParse({ va: -1 }).success).toBe(false);
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

describe('guards', () => {
  const entity = parseEntity(climSalon);

  it('isKind restreint le type du value', () => {
    expect(isKind(entity, 'climate')).toBe(true);
    expect(isKind(entity, 'temperature')).toBe(false);
    if (isKind(entity, 'climate')) {
      // pas de cast : `value` est typé ClimateValue dans cette branche
      expect(entity.value.targetTemp).toBe(20.5);
      expect(entity.value.mode).toBe('heat');
    }
  });

  it('isKind est faux si le value ne respecte pas le schéma du kind', () => {
    // enveloppe valide (Entity.value est z.unknown()) mais value incohérent
    const loose = { ...entity, value: { power: true } } as typeof entity;
    expect(isKind(loose, 'climate')).toBe(false);
  });

  it('valueOf parse et retourne le value typé, sinon undefined', () => {
    expect(valueOf(entity, 'climate')?.targetTemp).toBe(20.5);
    expect(valueOf(entity, 'temperature')).toBeUndefined();
    expect(valueOf({ ...entity, value: 'nope' }, 'climate')).toBeUndefined();
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

  it('rejette un statut d’ack hors enum', () => {
    expect(
      Ack.safeParse({ commandId: '0b8e7c5e-1d2f-4a3b-9c8d-7e6f5a4b3c2d', status: 'peut-être' })
        .success,
    ).toBe(false);
  });
});

describe('Health', () => {
  it('accepte online/offline et rejette le reste', () => {
    expect(Health.safeParse({ status: 'online', ts: '2026-11-14T06:12:03Z' }).success).toBe(true);
    expect(Health.safeParse({ status: 'offline', ts: '2026-11-14T06:12:03Z' }).success).toBe(true);
    expect(Health.safeParse({ status: 'zombie', ts: '2026-11-14T06:12:03Z' }).success).toBe(false);
    expect(Health.safeParse({ status: 'online' }).success).toBe(false);
    expect(Health.safeParse({ status: 'online', ts: 'tout à l’heure' }).success).toBe(false);
  });
});

describe('BusEvent', () => {
  it('accepte un événement ponctuel, data optionnel', () => {
    expect(
      BusEvent.safeParse({ driver: 'doorbell', type: 'pressed', ts: '2026-11-14T06:12:03Z' })
        .success,
    ).toBe(true);
    expect(
      BusEvent.safeParse({
        driver: 'doorbell',
        type: 'pressed',
        data: { button: 'front' },
        ts: '2026-11-14T06:12:03Z',
      }).success,
    ).toBe(true);
  });

  it('exige driver, type et un ts ISO', () => {
    expect(BusEvent.safeParse({ type: 'pressed', ts: '2026-11-14T06:12:03Z' }).success).toBe(false);
    expect(BusEvent.safeParse({ driver: 'doorbell', ts: '2026-11-14T06:12:03Z' }).success).toBe(
      false,
    );
    expect(BusEvent.safeParse({ driver: 'doorbell', type: 'pressed', ts: 'hier' }).success).toBe(
      false,
    );
  });
});

describe('Manifest', () => {
  it('valide un manifeste minimal', () => {
    const manifest = Manifest.parse({
      driver: 'fake',
      version: '0.1.0',
      entities: [{ id: 'clim_salon', kind: 'climate', room: 'salon' }],
      // params d'un `set` climate : le schéma des champs modifiables, pas un state complet
      commands: [{ action: 'set', paramsSchema: toJsonSchema(ClimateValue.partial()) }],
    });
    expect(manifest.entities).toHaveLength(1);
    expect(manifest.commands[0]?.paramsSchema).toHaveProperty('properties.targetTemp');
  });

  it('rejette un manifeste dont une entité a un kind inconnu', () => {
    expect(
      Manifest.safeParse({
        driver: 'fake',
        version: '0.1.0',
        entities: [{ id: 'x', kind: 'toaster' }],
        commands: [],
      }).success,
    ).toBe(false);
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
    expect(matchTopic('home/ack/+', 'home/ack/0b8e7c5e')).toBe(true);
  });
});

describe('selector', () => {
  const entity = parseEntity(climSalon);
  it('matche par kind + room, jamais par nom de driver requis', () => {
    expect(matchesSelector(entity, { kind: 'climate', room: 'salon' })).toBe(true);
    expect(matchesSelector(entity, { kind: 'climate', room: 'chambre' })).toBe(false);
    expect(matchesSelector(entity, {})).toBe(true);
    expect(matchesSelector(entity, { id: 'clim_salon' })).toBe(true);
  });

  it('filtre aussi par driver (outillage/debug uniquement)', () => {
    expect(matchesSelector(entity, { driver: 'midea' })).toBe(true);
    expect(matchesSelector(entity, { driver: 'hue' })).toBe(false);
    expect(matchesSelector(entity, { driver: 'midea', kind: 'light' })).toBe(false);
    expect(matchesSelector(entity, { driver: 'midea', id: 'clim_chambre' })).toBe(false);
  });

  it('ne matche pas une room absente de l’entité', () => {
    const sansRoom = parseEntity({ ...climSalon, room: undefined });
    expect(matchesSelector(sansRoom, { room: 'salon' })).toBe(false);
    expect(matchesSelector(sansRoom, { kind: 'climate' })).toBe(true);
  });
});

describe('json-schema', () => {
  it('exporte un JSON Schema exploitable (structure, pas sérialisation)', () => {
    const schema = toJsonSchema(Command) as {
      $schema: string;
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema).toHaveProperty('$schema');
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['id', 'target', 'action', 'params', 'issuedBy', 'ts']),
    );
    expect(schema.properties['issuedBy']).toMatchObject({
      type: 'string',
      enum: ['core', 'agent', 'voice', 'ui', 'cli'],
    });
    expect(schema.required).toContain('issuedBy');
  });

  it('nommé, le schéma passe par $ref + definitions', () => {
    const schema = toJsonSchema(Command, 'Command') as {
      $ref: string;
      definitions: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(schema.$ref).toBe('#/definitions/Command');
    expect(schema.definitions['Command']?.properties).toHaveProperty('issuedBy');
  });
});
