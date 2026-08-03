import { describe, expect, it } from 'vitest';
import { ClimateValue } from '@stellar/contracts';
import { createFakeAppliance } from './fake.js';
import { loadStatusFixture } from './fixtures.js';
import {
  climatePatchToStatus,
  fanSpeedFromContract,
  fanSpeedToContract,
  MideaMappingError,
  statusToClimateValue,
} from './mapping.js';
import { MideaStatus, normalizeStatus } from './status.js';

const base = (overrides: Partial<MideaStatus> = {}): MideaStatus =>
  MideaStatus.parse({
    powerOn: true,
    mode: 4,
    temperatureSetpoint: 20.5,
    indoorTemperature: 19.8,
    fanSpeed: 102,
    ...overrides,
  });

describe('normalizeStatus', () => {
  it('aplatit les { value, description } de lib/reporter.js', () => {
    expect(
      normalizeStatus({
        powerOn: true,
        mode: { value: 2, description: 'cool' },
        temperatureSetpoint: 24,
        indoorTemperature: 27.2,
        fanSpeed: { value: 60, description: 'medium' },
      }),
    ).toMatchObject({ mode: 2, fanSpeed: 60 });
  });

  it('accepte aussi la forme déjà plate (setStatus de certains firmwares)', () => {
    expect(
      normalizeStatus({ powerOn: false, mode: 1, temperatureSetpoint: 21, fanSpeed: 40 }),
    ).toMatchObject({ mode: 1, fanSpeed: 40 });
  });

  it('conserve les propriétés inconnues (passthrough) — les fixtures verify en vivent', () => {
    const status = normalizeStatus({
      powerOn: true,
      mode: 4,
      temperatureSetpoint: 20,
      fanSpeed: 80,
      outdoorTemperature: 6.5,
      byte3bit4: true,
    });
    expect(status).toMatchObject({ outdoorTemperature: 6.5, byte3bit4: true });
  });

  it('rejette un statut amputé plutôt que d’inventer un état', () => {
    expect(() => normalizeStatus({ powerOn: true, mode: 4 })).toThrow();
    expect(() => normalizeStatus(null)).toThrow();
  });
});

describe('statusToClimateValue', () => {
  it('produit un ClimateValue conforme au contrat', () => {
    const value = statusToClimateValue(base());
    expect(ClimateValue.parse(value)).toEqual({
      power: true,
      mode: 'heat',
      targetTemp: 20.5,
      indoorTemp: 19.8,
      fan: 'auto',
    });
  });

  it('mappe les 6 modes Midea sur le contrat', () => {
    const modeOf = (mode: number): string => statusToClimateValue(base({ mode })).mode;
    expect([1, 2, 3, 4, 5].map(modeOf)).toEqual(['auto', 'cool', 'dry', 'heat', 'fan']);
    // customdry n'a pas d'équivalent au contrat : rapporté en `dry`, jamais écrit.
    expect(modeOf(6)).toBe('dry');
  });

  it('omet indoorTemp quand l’unité ne rapporte pas de sonde', () => {
    const value = statusToClimateValue(
      MideaStatus.parse({ powerOn: false, mode: 1, temperatureSetpoint: 21, fanSpeed: 40 }),
    );
    expect(value.indoorTemp).toBeUndefined();
    expect(ClimateValue.parse(value)).not.toHaveProperty('indoorTemp');
  });

  it('erreur propre sur un mode inconnu, pas un état bancal', () => {
    expect(() => statusToClimateValue(base({ mode: 9 }))).toThrow(MideaMappingError);
    expect(() => statusToClimateValue(base({ mode: 9 }))).toThrow(/mode Midea inconnu: 9/);
  });
});

describe('fanSpeed', () => {
  it('rend les sentinelles hors échelle par leur nom', () => {
    expect(fanSpeedToContract(102)).toBe('auto');
    expect(fanSpeedToContract(101)).toBe('fixed');
    expect(fanSpeedToContract(60)).toBe('60');
  });

  it('relit les noms écrivables et les pourcentages', () => {
    expect(fanSpeedFromContract('auto')).toBe('auto');
    expect(fanSpeedFromContract('medium')).toBe('medium');
    expect(fanSpeedFromContract('60')).toBe(60);
    expect(fanSpeedFromContract('0')).toBe(0);
  });

  it('refuse ce que setStatus ne sait pas écrire', () => {
    // `fixed` est lisible (101) mais absent de la table d'écriture de lib/ac.js.
    expect(() => fanSpeedFromContract('fixed')).toThrow(MideaMappingError);
    expect(() => fanSpeedFromContract('turbo')).toThrow(MideaMappingError);
    expect(() => fanSpeedFromContract('120')).toThrow(MideaMappingError);
    expect(() => fanSpeedFromContract('60.5')).toThrow(MideaMappingError);
  });
});

describe('climatePatchToStatus', () => {
  it('traduit vers le vocabulaire d’écriture de la lib', () => {
    expect(
      climatePatchToStatus({ power: true, mode: 'fan', targetTemp: 22, fan: 'medium' }),
    ).toEqual({
      powerOn: true,
      mode: 'fanonly',
      temperatureSetpoint: 22,
      fanSpeed: 'medium',
    });
  });

  it('n’écrit que ce qui est demandé (patch partiel)', () => {
    expect(climatePatchToStatus({ targetTemp: 19 })).toEqual({ temperatureSetpoint: 19 });
    expect(climatePatchToStatus({})).toEqual({});
  });

  it('aller-retour : un état lu se réécrit à l’identique', async () => {
    const fake = createFakeAppliance({ fixture: 'status-cool' });
    const read = statusToClimateValue(await fake.getStatus());

    // Tout le ClimateValue lu repart en commande…
    const applied = statusToClimateValue(
      await fake.setStatus(
        climatePatchToStatus({
          power: read.power,
          mode: read.mode,
          targetTemp: read.targetTemp,
          fan: read.fan,
        }),
      ),
    );
    // …et l'unité se retrouve exactement dans l'état d'où l'on est parti.
    expect(applied).toEqual(read);
  });

  it('aller-retour sur les trois fixtures', async () => {
    for (const fixture of ['status-heat', 'status-cool', 'status-off'] as const) {
      const status = loadStatusFixture(fixture);
      const read = statusToClimateValue(status);
      const fake = createFakeAppliance({ fixture });
      const applied = statusToClimateValue(
        await fake.setStatus(
          climatePatchToStatus({
            power: read.power,
            mode: read.mode,
            targetTemp: read.targetTemp,
            fan: read.fan,
          }),
        ),
      );
      expect(applied).toEqual(read);
    }
  });
});
