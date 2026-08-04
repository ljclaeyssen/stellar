import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { Manifest, isKind, type Entity } from '@stellar/contracts';
import { startSimZ2m, type SimZ2m } from '@stellar/sim-z2m';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import { startZ2mNormalizer, type Z2mNormalizerHandle } from './driver.js';
import { indexMappingTable, loadMappingTable, type MappingIndex } from './mapping-table.js';

/**
 * Niveau 2 d'ADR-010 : broker aedes + `@stellar/sim-z2m` rejouant les fixtures.
 * La table chargée est **celle du dépôt** (`config/z2m-mapping.json`) : ces tests
 * échouent si la table livrée dérive des fixtures, ce qui est exactement le
 * signal voulu.
 */
const MAPPING_FILE = fileURLToPath(new URL('../../../../config/z2m-mapping.json', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../__fixtures__', import.meta.url));

const silent = (): Logger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

describe('z2m-normalizer contre le simulateur', () => {
  // Broker et simulateur recréés à chaque test : les messages *retained*
  // (états, availability, manifeste) fuiraient sinon d'un test à l'autre.
  let broker: TestBroker;
  let sim: SimZ2m;
  let driverBus: Bus;
  let consumer: Bus;
  let index: MappingIndex;
  let handle: Z2mNormalizerHandle;
  let states: Entity[];
  let manifests: unknown[];
  let infos: string[];
  let warns: string[];
  let errors: string[];

  const driverLogger = (): Logger => ({
    debug: () => undefined,
    info: (msg) => infos.push(msg),
    warn: (msg) => warns.push(msg),
    error: (msg) => errors.push(msg),
  });

  const latest = (id: string): Entity => {
    const found = states.filter((entity) => entity.id === id).at(-1);
    if (found === undefined) throw new Error(`aucun state publié pour ${id}`);
    return found;
  };
  const idsSeen = (): string[] => [...new Set(states.map((entity) => entity.id))].sort();
  const countOf = (id: string): number => states.filter((entity) => entity.id === id).length;

  beforeEach(async () => {
    infos = [];
    warns = [];
    errors = [];
    states = [];
    manifests = [];

    broker = await startTestBroker();
    index = await loadMappingTable(MAPPING_FILE);

    driverBus = await createBus({
      url: broker.url,
      clientId: `z2m-driver-${randomUUID()}`,
      driver: 'z2m',
      protocolVersion: 4,
      logger: silent(),
    });
    consumer = await createBus({
      url: broker.url,
      clientId: `test-consumer-${randomUUID()}`,
      driver: 'consumer',
      protocolVersion: 4,
      logger: silent(),
    });
    await consumer.onState({ driver: 'z2m' }, (entity) => states.push(entity));
    // Le manifeste n'a pas d'API dédiée sur le bus : on l'observe en brut.
    consumer.client.on('message', (topic, payload) => {
      if (topic === 'home/discovery/z2m') manifests.push(JSON.parse(payload.toString()));
    });
    await consumer.client.subscribeAsync('home/discovery/z2m', { qos: 1 });

    sim = await startSimZ2m({
      url: broker.url,
      fixturesDir: FIXTURES_DIR,
      protocolVersion: 4,
      clientId: `sim-z2m-${randomUUID()}`,
    });
    handle = await startZ2mNormalizer({ bus: driverBus, index, logger: driverLogger() });
  });

  afterEach(async () => {
    await sim.close();
    await handle.close();
    await consumer.close();
    await driverBus.close();
    await broker.close();
  });

  it('traduit les fixtures en entités retained conformes aux contrats', async () => {
    await sim.addDevice({ friendlyName: 'temp_salon', payloadFile: 'snzb-02d.json' });
    await sim.addDevice({ friendlyName: 'presence_salon', payloadFile: 'zy-m100.json' });
    await sim.addDevice({ friendlyName: 'zlinky', payloadFile: 'zlinky-tic.json' });
    for (const name of sim.deviceNames) await sim.publishOnce(name);

    await vi.waitFor(() => {
      expect(idsSeen()).toEqual(['humidity_salon', 'power_maison', 'presence_salon', 'temp_salon']);
    });

    const temperature = latest('temp_salon');
    expect(isKind(temperature, 'temperature')).toBe(true);
    expect(temperature.value).toBe(21.3);
    expect(temperature.driver).toBe('z2m');
    expect(temperature.room).toBe('salon');
    expect(temperature.unit).toBe('°C');
    expect(temperature.stale).toBeUndefined();

    const humidity = latest('humidity_salon');
    expect(isKind(humidity, 'humidity')).toBe(true);
    expect(humidity.value).toBe(47);

    const presence = latest('presence_salon');
    expect(isKind(presence, 'presence')).toBe(true);
    expect(presence.value).toBe(true);

    const power = latest('power_maison');
    expect(isKind(power, 'power')).toBe(true);
    expect(power.value).toEqual({ va: 1240, indexBase: 12345678 });
    // ZLinky : `room: null` dans la table ⇒ pas de pièce sur le bus.
    expect(power.room).toBeUndefined();

    expect(warns).toEqual([]);
    expect(errors).toEqual([]);

    // Retained : un abonné tardif retrouve tout l'état sans qu'un capteur reparle.
    const late: Entity[] = [];
    const lateBus = await createBus({
      url: broker.url,
      clientId: `late-${randomUUID()}`,
      driver: 'late',
      protocolVersion: 4,
      logger: silent(),
    });
    try {
      await lateBus.onState({ driver: 'z2m' }, (entity) => late.push(entity));
      await vi.waitFor(() => {
        expect([...new Set(late.map((entity) => entity.id))].sort()).toEqual([
          'humidity_salon',
          'power_maison',
          'presence_salon',
          'temp_salon',
        ]);
      });
    } finally {
      await lateBus.close();
    }
  });

  it('annonce un manifeste dérivé de la table, sans aucune commande', async () => {
    await vi.waitFor(() => {
      expect(manifests.length).toBeGreaterThan(0);
    });

    const manifest = Manifest.parse(manifests.at(-1));
    expect(manifest.driver).toBe('z2m');
    expect(manifest.commands).toEqual([]);
    expect(manifest.entities.map((entity) => entity.id)).toEqual(index.entityIds);
    expect(manifest.entities).toContainEqual({
      id: 'presence_entree',
      kind: 'presence',
      room: 'entree',
    });
  });

  it('publie la seule entité présente quand le payload est partiel', async () => {
    await sim.addDevice({
      friendlyName: 'temp_salon',
      payload: { temperature: 22.1, battery: 88, linkquality: 120 },
    });
    await sim.publishOnce('temp_salon');

    await vi.waitFor(() => {
      expect(latest('temp_salon').value).toBe(22.1);
    });
    await handle.drain();

    expect(idsSeen()).toEqual(['temp_salon']);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejette une valeur aberrante et conserve l’état précédent', async () => {
    await sim.addDevice({ friendlyName: 'temp_salon', payloadFile: 'snzb-02d.json' });
    await sim.publishOnce('temp_salon');
    await vi.waitFor(() => {
      expect(latest('temp_salon').value).toBe(21.3);
    });

    // Sonde qui déraille : la température part, l'humidité reste bonne.
    await sim.setField('temp_salon', 'temperature', 999);
    await vi.waitFor(() => {
      expect(countOf('humidity_salon')).toBe(2);
    });
    await handle.drain();

    expect(countOf('temp_salon')).toBe(1);
    expect(latest('temp_salon').value).toBe(21.3);
    expect(warns.join(' | ')).toMatch(/hors contrat/);
    expect(errors).toEqual([]);
  });

  it('signale une seule fois un device absent de la table et ne publie rien', async () => {
    await sim.addDevice({ friendlyName: 'capteur_bureau', payloadFile: 'snzb-02d.json' });
    await sim.publishOnce('capteur_bureau');
    await sim.publishOnce('capteur_bureau');

    await vi.waitFor(() => {
      expect(handle.unmapped).toEqual(['capteur_bureau']);
    });
    await handle.drain();

    expect(infos.filter((msg) => msg.includes('capteur_bureau'))).toHaveLength(1);
    expect(infos.join(' | ')).toMatch(/config\/z2m-mapping\.json/);
    expect(states).toEqual([]);
    expect(warns).toEqual([]);
  });

  it.each([['json'], ['legacy']] as const)(
    'marque les entités stale sur availability offline (format %s) puis repart au payload frais',
    async (format) => {
      await sim.addDevice({ friendlyName: 'temp_salon', payloadFile: 'snzb-02d.json' });
      await sim.publishOnce('temp_salon');
      await vi.waitFor(() => {
        expect(idsSeen()).toEqual(['humidity_salon', 'temp_salon']);
      });

      await sim.setAvailability('temp_salon', false, format);
      await vi.waitFor(() => {
        expect(latest('temp_salon').stale).toBe(true);
        expect(latest('humidity_salon').stale).toBe(true);
      });
      // Stale ne veut pas dire « effacé » : la dernière valeur connue reste lisible.
      expect(latest('temp_salon').value).toBe(21.3);
      expect(handle.offline).toEqual(['temp_salon']);

      // Retour en ligne : aucune republication optimiste, on attend un vrai payload.
      await sim.setAvailability('temp_salon', true, format);
      await handle.drain();
      expect(latest('temp_salon').stale).toBe(true);

      await sim.publishOnce('temp_salon', { temperature: 20.8 });
      await vi.waitFor(() => {
        expect(latest('temp_salon').value).toBe(20.8);
        expect(latest('temp_salon').stale).toBeUndefined();
      });
      expect(handle.offline).toEqual([]);
    },
  );

  it('ne fabrique aucun stale sur le simple silence d’un capteur', async () => {
    await sim.addDevice({
      friendlyName: 'temp_salon',
      payloadFile: 'snzb-02d.json',
      periodMs: 30,
    });
    sim.start();
    await vi.waitFor(() => {
      expect(countOf('temp_salon')).toBeGreaterThanOrEqual(2);
    });

    // Pile morte : le device se tait, sans rien annoncer. Décider que c'est
    // anormal est le rôle du core (seuils par kind, P5), pas du traducteur.
    sim.stopDevice('temp_salon');
    await handle.drain();

    // D'abord laisser retomber les livraisons en vol (QoS 1 parties AVANT le
    // stop peuvent arriver après, surtout en CI lente) : attendre la stabilité,
    // PUIS vérifier qu'il ne se publie plus rien.
    await vi.waitFor(async () => {
      const before = states.length;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handle.drain();
      expect(states.length).toBe(before);
    });

    expect(states.every((entity) => entity.stale === undefined)).toBe(true);
    expect(handle.offline).toEqual([]);
  });

  it('rend visible un device ajouté à la table, sans autre changement (spec §13)', async () => {
    // Le seul artefact modifié est la table : ni code, ni contrat, ni core.
    const extended = structuredClone(index.table);
    extended.devices.push({
      friendlyName: 'presence_bureau',
      model: 'ZY-M100',
      room: 'bureau',
      entities: [{ entityId: 'presence_bureau', kind: 'presence', field: 'presence' }],
    });

    await handle.close();
    handle = await startZ2mNormalizer({
      bus: driverBus,
      index: indexMappingTable(extended),
      logger: driverLogger(),
    });

    await sim.addDevice({ friendlyName: 'presence_bureau', payloadFile: 'zy-m100.json' });
    await sim.publishOnce('presence_bureau');

    await vi.waitFor(() => {
      const entity = latest('presence_bureau');
      expect(isKind(entity, 'presence')).toBe(true);
      expect(entity.room).toBe('bureau');
    });
    await vi.waitFor(() => {
      expect(Manifest.parse(manifests.at(-1)).entities.map((entity) => entity.id)).toContain(
        'presence_bureau',
      );
    });
    expect(handle.unmapped).toEqual([]);
  });
});
