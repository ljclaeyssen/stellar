import { describe, expect, it } from 'vitest';
import { DeviceMapping } from './mapping-table.js';
import { normalizeDevice } from './normalize.js';

const sensor = DeviceMapping.parse({
  friendlyName: 'temp_salon',
  model: 'SNZB-02D',
  room: 'salon',
  entities: [
    { entityId: 'temp_salon', kind: 'temperature', field: 'temperature', unit: '°C' },
    { entityId: 'humidity_salon', kind: 'humidity', field: 'humidity', unit: '%' },
  ],
});

const zlinky = (indexRef: unknown = 'current_summ_delivered'): DeviceMapping =>
  DeviceMapping.parse({
    friendlyName: 'zlinky',
    model: 'ZLinky_TIC',
    room: null,
    entities: [
      {
        entityId: 'power_maison',
        kind: 'power',
        fields: { va: 'apparent_power', indexBase: indexRef },
      },
    ],
  });

describe('normalisation d’un payload Z2M', () => {
  it('traduit un payload complet, en ignorant les champs non déclarés', () => {
    const outcome = normalizeDevice(sensor, {
      temperature: 21.3,
      humidity: 47,
      battery: 91,
      linkquality: 132,
      voltage: 3000,
    });

    expect(outcome.rejected).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.percepts).toEqual([
      { entityId: 'temp_salon', kind: 'temperature', room: 'salon', unit: '°C', value: 21.3 },
      { entityId: 'humidity_salon', kind: 'humidity', room: 'salon', unit: '%', value: 47 },
    ]);
  });

  it('ne publie que ce que le payload contient (payloads Z2M partiels)', () => {
    const outcome = normalizeDevice(sensor, { temperature: 22.1, battery: 88 });

    expect(outcome.percepts.map((percept) => percept.entityId)).toEqual(['temp_salon']);
    expect(outcome.skipped).toEqual([{ entityId: 'humidity_salon', missing: ['humidity'] }]);
    expect(outcome.rejected).toEqual([]);
  });

  it('traite un champ à null comme absent, pas comme une erreur', () => {
    const outcome = normalizeDevice(sensor, { temperature: 21, humidity: null });

    expect(outcome.percepts.map((percept) => percept.entityId)).toEqual(['temp_salon']);
    expect(outcome.rejected).toEqual([]);
  });

  it('rejette une valeur hors bornes du contrat', () => {
    const outcome = normalizeDevice(sensor, { temperature: 999, humidity: 47 });

    expect(outcome.percepts.map((percept) => percept.entityId)).toEqual(['humidity_salon']);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.entityId).toBe('temp_salon');
    expect(outcome.rejected[0]?.value).toBe(999);
  });

  it('rejette une valeur du mauvais type (présence non booléenne)', () => {
    const mmwave = DeviceMapping.parse({
      friendlyName: 'presence_salon',
      room: 'salon',
      entities: [{ entityId: 'presence_salon', kind: 'presence', field: 'presence' }],
    });

    const outcome = normalizeDevice(mmwave, { presence: 'on' });

    expect(outcome.percepts).toEqual([]);
    expect(outcome.rejected[0]?.entityId).toBe('presence_salon');
  });

  it('compose une valeur multi-champs, sans pièce quand la table n’en déclare pas', () => {
    const outcome = normalizeDevice(zlinky(), {
      apparent_power: 1240,
      current_summ_delivered: 12345678,
      linkquality: 90,
    });

    expect(outcome.percepts).toEqual([
      {
        entityId: 'power_maison',
        kind: 'power',
        value: { va: 1240, indexBase: 12345678 },
      },
    ]);
  });

  it('publie une valeur composée en tout-ou-rien', () => {
    const outcome = normalizeDevice(zlinky(), { apparent_power: 1240 });

    expect(outcome.percepts).toEqual([]);
    expect(outcome.skipped).toEqual([
      { entityId: 'power_maison', missing: ['current_summ_delivered'] },
    ]);
    expect(outcome.rejected).toEqual([]);
  });

  it('applique le facteur d’échelle déclaré (Wh → kWh)', () => {
    const outcome = normalizeDevice(zlinky({ field: 'current_summ_delivered', scale: 0.001 }), {
      apparent_power: 1240,
      current_summ_delivered: 12_345_000,
    });

    expect(outcome.percepts[0]?.value).toEqual({ va: 1240, indexBase: 12_345 });
  });

  it('rejette un scale sur un champ non numérique', () => {
    const outcome = normalizeDevice(zlinky({ field: 'current_summ_delivered', scale: 0.001 }), {
      apparent_power: 1240,
      current_summ_delivered: 'ERREUR',
    });

    expect(outcome.percepts).toEqual([]);
    expect(outcome.rejected[0]?.reason).toMatch(/scale inapplicable/);
  });
});
