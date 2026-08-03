import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@stellar/bus';
import { valueSchemas } from '@stellar/contracts';
import {
  MODE_BY_SETPOINT,
  buildStationPercepts,
  buildThermostatPercepts,
  buildThermostatTopology,
  slug,
  toClimateValue,
  type Percept,
} from './mapping.js';
import {
  HomeStatusRoom,
  HomesDataHome,
  StationDevice,
  StationModule,
  type NetatmoStation,
} from './netatmo.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const fixture = (name: string): { body: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/api/${name}`, import.meta.url), 'utf8')) as {
    body: Record<string, unknown>;
  };

const homes = (fixture('homesdata.json').body['homes'] as unknown[]).map((home) =>
  HomesDataHome.parse(home),
);
const statusRooms = (fixture('homestatus.json').body['home'] as { rooms: unknown[] }).rooms.map(
  (room) => HomeStatusRoom.parse(room),
);
const device = StationDevice.parse(
  (fixture('getstationsdata.json').body['devices'] as unknown[])[0],
);

/** Reconstitue la mise à plat faite par `api.getStationsData` (NAMain en tête). */
const station = (): NetatmoStation => ({
  id: device._id,
  stationName: device.station_name ?? device._id,
  modules: [
    StationModule.parse({
      _id: device._id,
      type: device.type,
      module_name: device.module_name,
      dashboard_data: device.dashboard_data,
    }),
    ...device.modules.map((module) => StationModule.parse(module)),
  ],
  raw: device,
});

const byId = (percepts: Percept[], id: string): Percept | undefined =>
  percepts.find((percept) => percept.entityId === id);

describe('slug', () => {
  it('normalise en snake_case sans accents', () => {
    expect(slug('Chambre bébé')).toBe('chambre_bebe');
    expect(slug('Extérieur')).toBe('exterieur');
    expect(slug('  ---  ')).toBe('sans_nom');
  });
});

describe('inventaire du chauffage (homesdata)', () => {
  it('retient les pièces équipées d’un NATherm1', () => {
    const topology = buildThermostatTopology(homes, silentLogger);
    expect(topology).toMatchObject({
      homeName: 'Maison',
      rooms: [{ entityId: 'thermostat_maison', room: 'maison', name: 'Maison' }],
    });
    // L'id de room Netatmo est conservé : c'est la cible des setroomthermpoint.
    expect(topology?.rooms[0]?.roomId).toBe('2745291958');
  });

  it('ignore une maison sans thermostat et signale les maisons surnuméraires', () => {
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn };
    const sansThermostat = HomesDataHome.parse({
      id: 'autre',
      name: 'Bureau',
      rooms: [{ id: 'r1', name: 'Bureau' }],
      modules: [{ id: 'm1', type: 'NAMain' }],
    });
    expect(buildThermostatTopology([sansThermostat], logger)).toBeNull();

    const seconde = HomesDataHome.parse({
      ...homes[0],
      id: 'home-2',
      name: 'Maison de vacances',
    });
    const topology = buildThermostatTopology([...homes, seconde], logger);
    expect(topology?.homeName).toBe('Maison');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('plusieurs maisons'),
      expect.anything(),
    );
  });
});

describe('mapping des modes Netatmo → ClimateValue', () => {
  it('applique la table documentée', () => {
    expect(MODE_BY_SETPOINT['manual']).toEqual({ power: true, mode: 'heat' });
    expect(MODE_BY_SETPOINT['max']).toEqual({ power: true, mode: 'heat' });
    expect(MODE_BY_SETPOINT['schedule']).toEqual({ power: true, mode: 'auto' });
    for (const mode of ['away', 'hg', 'off']) {
      expect(MODE_BY_SETPOINT[mode]).toEqual({ power: false, mode: 'heat' });
    }
  });

  it('produit une value conforme au contrat, fan compris', () => {
    const room = statusRooms[0];
    if (room === undefined) throw new Error('fixture homestatus sans room');
    const value = toClimateValue(room, silentLogger);
    expect(value).toEqual({
      power: true,
      mode: 'auto',
      targetTemp: 19,
      indoorTemp: 19.4,
      fan: 'none',
    });
    expect(valueSchemas.climate.safeParse(value).success).toBe(true);
  });

  it('traite un mode inconnu comme « pas de chauffe » plutôt que de perdre la pièce', () => {
    const warn = vi.fn();
    const value = toClimateValue(
      HomeStatusRoom.parse({
        id: 'r1',
        therm_setpoint_temperature: 18,
        therm_setpoint_mode: 'ovni',
      }),
      { ...silentLogger, warn },
    );
    expect(value).toMatchObject({ power: false, mode: 'heat', targetTemp: 18 });
    expect(warn).toHaveBeenCalled();
  });

  it('n’invente pas de consigne quand Netatmo n’en donne pas', () => {
    expect(
      toClimateValue(HomeStatusRoom.parse({ id: 'r1', reachable: false }), silentLogger),
    ).toBeNull();
  });

  it('marque stale une pièce dont le thermostat est injoignable (ADR-009)', () => {
    const topology = buildThermostatTopology(homes, silentLogger);
    if (topology === null) throw new Error('topologie attendue');
    const percepts = buildThermostatPercepts(
      {
        id: 'home',
        rooms: [
          HomeStatusRoom.parse({
            id: '2745291958',
            reachable: false,
            therm_setpoint_temperature: 19,
            therm_setpoint_mode: 'schedule',
          }),
        ],
        modules: [],
      },
      topology,
      silentLogger,
    );
    expect(percepts[0]).toMatchObject({ entityId: 'thermostat_maison', stale: true });
  });
});

describe('percepts de la station météo', () => {
  // Horloge injectée calée sur la fixture : celle-ci est une capture figée, la
  // juger avec l'heure du jour la déclarerait périmée à chaque exécution.
  const now = (device.dashboard_data?.time_utc ?? 0) * 1_000 + 60_000;

  it('publie température, humidité et un agrégat weather', () => {
    const percepts = buildStationPercepts([station()], { logger: silentLogger, now });

    expect(percepts.map((percept) => percept.entityId)).toEqual([
      'temp_salon',
      'humidity_salon',
      'temp_exterieur',
      'humidity_exterieur',
      'weather_maison',
    ]);
    expect(byId(percepts, 'temp_salon')).toMatchObject({
      kind: 'temperature',
      unit: '°C',
      room: 'salon',
      value: 20.8,
    });
    expect(byId(percepts, 'humidity_exterieur')).toMatchObject({ kind: 'humidity', value: 82 });
    expect(byId(percepts, 'weather_maison')?.value).toMatchObject({
      pressure: 1014.2,
      absolutePressure: 1010.6,
      co2: 638,
      noise: 36,
      tempIn: 20.8,
      tempOut: 8.3,
      humidityOut: 82,
    });
    for (const percept of percepts) expect(percept.stale).toBeUndefined();
    expect(valueSchemas.temperature.safeParse(byId(percepts, 'temp_salon')?.value).success).toBe(
      true,
    );
    expect(valueSchemas.weather.safeParse(byId(percepts, 'weather_maison')?.value).success).toBe(
      true,
    );
  });

  it('marque stale une mesure trop vieille et un module injoignable', () => {
    const vieux = station();
    const percepts = buildStationPercepts([vieux], {
      logger: silentLogger,
      now,
      freshnessMs: 1,
    });
    expect(percepts.every((percept) => percept.stale === true)).toBe(true);
  });

  it('ne publie rien pour un module qui n’a jamais mesuré', () => {
    const sansMesure = station();
    sansMesure.modules = sansMesure.modules.map((module) =>
      module.type === 'NAModule1'
        ? StationModule.parse({ ...module, dashboard_data: undefined })
        : module,
    );
    const percepts = buildStationPercepts([sansMesure], { logger: silentLogger, now });
    expect(percepts.map((percept) => percept.entityId)).not.toContain('temp_exterieur');
    expect(percepts.map((percept) => percept.entityId)).toContain('temp_salon');
  });

  it('jette une mesure hors bornes physiques plutôt que de casser le contrat', () => {
    const warn = vi.fn();
    const cassee = station();
    const [main] = cassee.modules;
    if (main === undefined) throw new Error('station sans module principal');
    cassee.modules = [
      StationModule.parse({
        ...main,
        dashboard_data: { ...main.dashboard_data, Temperature: 999 },
      }),
    ];
    const percepts = buildStationPercepts([cassee], {
      logger: { ...silentLogger, warn },
      now,
    });
    expect(percepts.map((percept) => percept.entityId)).not.toContain('temp_salon');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hors bornes'), expect.anything());
  });
});
