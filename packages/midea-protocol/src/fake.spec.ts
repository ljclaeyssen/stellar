import { describe, expect, it } from 'vitest';
import { isUnreachable, MideaUnreachableError } from './appliance.js';
import { createFakeAppliance } from './fake.js';
import { FIXTURE_NAMES, loadStatusFixture } from './fixtures.js';

describe('fixtures', () => {
  it('toutes les fixtures se normalisent en MideaStatus', () => {
    for (const name of FIXTURE_NAMES) {
      expect(loadStatusFixture(name)).toMatchObject({
        powerOn: expect.any(Boolean) as boolean,
        mode: expect.any(Number) as number,
        temperatureSetpoint: expect.any(Number) as number,
        fanSpeed: expect.any(Number) as number,
      });
    }
  });

  it('le `_note` de la fixture ne fuit pas dans le statut', () => {
    expect(loadStatusFixture('status-heat')).not.toHaveProperty('_note');
  });
});

describe('createFakeAppliance', () => {
  it('démarre sur la fixture, écrasable champ par champ', async () => {
    const fake = createFakeAppliance({
      fixture: 'status-cool',
      status: { temperatureSetpoint: 26 },
    });
    await expect(fake.getStatus()).resolves.toMatchObject({ mode: 2, temperatureSetpoint: 26 });
  });

  it('setStatus applique le patch et rend l’état résultant', async () => {
    const fake = createFakeAppliance();
    const after = await fake.setStatus({ powerOn: false, mode: 'cool', temperatureSetpoint: 23 });
    expect(after).toMatchObject({ powerOn: false, mode: 2, temperatureSetpoint: 23 });
    expect(fake.status).toMatchObject({ mode: 2 });
  });

  it('setStatus refuse un patch invalide, même unité joignable', async () => {
    const fake = createFakeAppliance();
    await expect(fake.setStatus({ temperatureSetpoint: 40 })).rejects.toThrow();
    await expect(
      fake.setStatus({ inconnu: true } as unknown as { powerOn: boolean }),
    ).rejects.toThrow();
  });

  it('setIndoor : la sonde bouge, le prochain getStatus le voit', async () => {
    const fake = createFakeAppliance();
    fake.setIndoor(23.4);
    await expect(fake.getStatus()).resolves.toMatchObject({ indoorTemperature: 23.4 });
  });

  it('failNext(n) : n échecs « unreachable » puis retour à la normale', async () => {
    const fake = createFakeAppliance();
    fake.failNext(2);
    await expect(fake.getStatus()).rejects.toThrow(MideaUnreachableError);
    await expect(fake.getStatus()).rejects.toThrow(MideaUnreachableError);
    await expect(fake.getStatus()).resolves.toBeDefined();
  });

  it('setUnreachable : panne franche jusqu’à remise en service', async () => {
    const fake = createFakeAppliance();
    fake.setUnreachable(true);
    await expect(fake.connect()).rejects.toSatisfy(isUnreachable);
    await expect(fake.getStatus()).rejects.toSatisfy(isUnreachable);
    await expect(fake.setStatus({ powerOn: true })).rejects.toSatisfy(isUnreachable);
    fake.setUnreachable(false);
    await expect(fake.getStatus()).resolves.toBeDefined();
  });

  it('latence simulable et appels comptés', async () => {
    const fake = createFakeAppliance({ latencyMs: 20 });
    const started = Date.now();
    await fake.getStatus();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    fake.setLatency(0);
    await fake.connect();
    expect(fake.calls).toMatchObject({ connect: 1, getStatus: 1 });
  });
});
