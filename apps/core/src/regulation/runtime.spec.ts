import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, type Bus, type Logger } from '@stellar/bus';
import { startTestBroker, type TestBroker } from '@stellar/test-utils';
import {
  ClimateMode,
  Kind,
  valueOf,
  type Ack,
  type ClimateValue,
  type Command,
  type TempoValue,
} from '@stellar/contracts';
import { createMirror, type Mirror } from '../mirror.js';
import { loadRegulationConfig, type RegulationConfig } from './regulation-config.js';
import {
  createRegulation,
  REGULATION_EVENT_TYPE,
  type Regulation,
  type RegulationEventData,
} from './runtime.js';

/**
 * INTÉGRATION DU RUNTIME DE RÉGULATION (P6) — sur un vrai broker.
 *
 * Les golden tests couvrent la décision (`decide`, fonction pure). Ce fichier
 * couvre ce que les goldens ne peuvent pas voir : la **plomberie**. Un percept
 * publié par un driver traverse le miroir, déclenche un tour, et la commande qui
 * en résulte arrive vraiment chez le driver destinataire — résolu par
 * `entity.driver` du miroir (ADR-008), jamais écrit dans le core.
 *
 * Le monde est un faux driver de clim (`fakeclim`) qui acquitte et republie son
 * état, plus une source de percepts (`fakepercepts`) : température, couleur du
 * jour, puissance instantanée. Le fait que `fakeclim` reçoive la commande **est**
 * la preuve du routage : il n'est abonné qu'à `home/cmd/fakeclim/+`.
 *
 * Déterminisme : l'horloge est injectée (aucun `Date.now`), l'intervalle du timer
 * est hors de portée du test, et les tours sont pilotés à la main par
 * `regulation.evaluate()` — sauf dans la première suite, qui teste justement le
 * déclenchement automatique sur publication d'état.
 */

const CLIM_DRIVER = 'fakeclim';
const PERCEPT_DRIVER = 'fakepercepts';
const TEMPO_ID = 'tempo_jour';
const POWER_ID = 'power_maison';

/** Assez long pour qu'aucun timer ne se déclenche pendant une suite. */
const NEVER = 3_600_000;

const PROD_CONFIG = fileURLToPath(new URL('../../../../config/regulation.yaml', import.meta.url));

/** 2026-01-15 14:00 heure locale (Europe/Paris) : plein jour, heures pleines. */
const JANVIER_15_14H = Date.UTC(2026, 0, 15, 13, 0);

/** clientId unique par monde : plusieurs suites se succèdent dans le même process. */
let worldSeq = 0;

// ──────────────────────────────── le monde ────────────────────────────────

interface ClimateSeed {
  power: boolean;
  targetTemp: number;
  mode?: ClimateMode;
  indoorTemp?: number;
}

interface FakeAppliance {
  room: string;
  value: ClimateValue;
}

/** Ce qu'on peut publier avant que la régulation n'existe (état initial du monde). */
interface Fixtures {
  seedClimate(id: string, room: string, seed: ClimateSeed): Promise<void>;
  seedTemperature(id: string, room: string, celsius: number): Promise<void>;
  seedTempo(
    couleurJour: TempoValue['couleurJour'],
    couleurDemain: TempoValue['couleurDemain'],
    periode: TempoValue['periode'],
  ): Promise<void>;
  seedPower(va: number): Promise<void>;
}

interface LoggedWarning {
  msg: string;
  extra?: Record<string, unknown>;
}

interface World extends Fixtures {
  mirror: Mirror;
  regulation: Regulation;
  /** Commandes reçues par le faux driver de clim (preuve de routage). */
  commands: Command[];
  /** `data` des `home/event/core/regulation`, vus par un tiers sur le bus. */
  events: RegulationEventData[];
  warnings: LoggedWarning[];
  advanceMin(minutes: number): void;
  /** Le faux driver rejettera toutes les commandes suivantes. */
  rejectCommands(reason: string): void;
  /** Attend que le miroir ait vu l'effet d'une commande. */
  awaitClimate(id: string, expected: Partial<ClimateValue>): Promise<void>;
  close(): Promise<void>;
}

interface WorldOptions {
  /** Instant initial (epoch ms). */
  start: number;
  /** Ajustements de la config de production (pièces retirées, seuils…). */
  tune?: (config: RegulationConfig) => void;
  /**
   * Regroupement des réévaluations déclenchées par le miroir. `NEVER` = aucun
   * tour spontané : le test pilote tout par `evaluate()`.
   */
  triggerDebounceMs: number;
  /** État du monde AVANT le montage de la régulation (aucun tour parasite). */
  seed?: (fixtures: Fixtures) => Promise<void>;
}

async function startWorld(options: WorldOptions): Promise<World> {
  worldSeq += 1;
  const seq = worldSeq;

  const warnings: LoggedWarning[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, extra) => {
      warnings.push({ msg, ...(extra !== undefined ? { extra } : {}) });
    },
    error: () => undefined,
  };

  const broker: TestBroker = await startTestBroker();
  const newBus = (driver: string): Promise<Bus> =>
    createBus({
      url: broker.url,
      clientId: `${driver}-regulation-${seq}`,
      driver,
      protocolVersion: 4,
      logger,
    });

  const climBus = await newBus(CLIM_DRIVER);
  const perceptBus = await newBus(PERCEPT_DRIVER);
  const coreBus = await newBus('core');

  let now = options.start;
  const at = (): string => new Date(now).toISOString();

  const appliances = new Map<string, FakeAppliance>();
  const commands: Command[] = [];
  const events: RegulationEventData[] = [];
  let rejection: string | undefined;

  const mirror = await createMirror({ bus: coreBus, logger });

  // Observateur tiers : les événements sont lus depuis un autre client que celui
  // qui les publie, comme le ferait n'importe quel abonné du bus.
  await perceptBus.onEvent(`core/${REGULATION_EVENT_TYPE}`, (event) => {
    events.push(event.data as RegulationEventData);
  });

  const publishAppliance = async (id: string): Promise<void> => {
    const appliance = appliances.get(id);
    if (!appliance) return;
    await climBus.publishState({
      id,
      driver: CLIM_DRIVER,
      kind: 'climate',
      room: appliance.room,
      value: appliance.value,
      ts: at(),
    });
  };

  // Le faux driver : il traduit et acquitte, il ne décide rien.
  await climBus.onCommand(async (cmd): Promise<Ack> => {
    commands.push(cmd);
    if (rejection !== undefined) {
      return { commandId: cmd.id, status: 'rejected', reason: rejection };
    }
    const appliance = appliances.get(cmd.target);
    if (!appliance) {
      return { commandId: cmd.id, status: 'rejected', reason: `${cmd.target} inconnu` };
    }
    const power = cmd.params['power'];
    const targetTemp = cmd.params['targetTemp'];
    const mode = ClimateMode.safeParse(cmd.params['mode']);
    appliance.value = {
      ...appliance.value,
      ...(typeof power === 'boolean' ? { power } : {}),
      ...(typeof targetTemp === 'number' ? { targetTemp } : {}),
      ...(mode.success ? { mode: mode.data } : {}),
    };
    await publishAppliance(cmd.target);
    return { commandId: cmd.id, status: 'ok' };
  });

  const awaitClimate = async (id: string, expected: Partial<ClimateValue>): Promise<void> => {
    await vi.waitFor(() => {
      const entity = mirror.getState(id);
      expect(entity && valueOf(entity, 'climate')).toMatchObject(expected);
    });
  };

  const fixtures: Fixtures = {
    async seedClimate(id, room, seed) {
      appliances.set(id, {
        room,
        value: {
          power: seed.power,
          mode: seed.mode ?? 'heat',
          targetTemp: seed.targetTemp,
          fan: 'auto',
          ...(seed.indoorTemp !== undefined ? { indoorTemp: seed.indoorTemp } : {}),
        },
      });
      await publishAppliance(id);
      await awaitClimate(id, { power: seed.power, targetTemp: seed.targetTemp });
    },

    async seedTemperature(id, room, celsius) {
      await perceptBus.publishState({
        id,
        driver: PERCEPT_DRIVER,
        kind: 'temperature',
        room,
        value: celsius,
        unit: '°C',
        ts: at(),
      });
      await vi.waitFor(() => expect(mirror.getState(id)?.value).toBe(celsius));
    },

    async seedTempo(couleurJour, couleurDemain, periode) {
      await perceptBus.publishState({
        id: TEMPO_ID,
        driver: PERCEPT_DRIVER,
        kind: Kind.enum.tempo,
        value: { couleurJour, couleurDemain, periode } satisfies TempoValue,
        ts: at(),
      });
      await vi.waitFor(() =>
        expect(mirror.getState(TEMPO_ID)?.value).toMatchObject({ couleurJour, periode }),
      );
    },

    async seedPower(va) {
      await perceptBus.publishState({
        id: POWER_ID,
        driver: PERCEPT_DRIVER,
        kind: 'power',
        room: 'maison',
        value: { va },
        unit: 'VA',
        ts: at(),
      });
      await vi.waitFor(() => expect(mirror.getState(POWER_ID)?.value).toMatchObject({ va }));
    },
  };

  await options.seed?.(fixtures);

  const config = loadRegulationConfig(PROD_CONFIG);
  options.tune?.(config);

  const regulation = await createRegulation({
    mirror,
    bus: coreBus,
    logger,
    config,
    clock: () => now,
    evaluateIntervalMs: NEVER,
    triggerDebounceMs: options.triggerDebounceMs,
    // Le faux driver répond immédiatement : un timeout ici serait une panne du test.
    commandTimeoutMs: 2_000,
  });

  return {
    ...fixtures,
    mirror,
    regulation,
    commands,
    events,
    warnings,
    awaitClimate,
    advanceMin(minutes) {
      now += minutes * 60_000;
    },
    rejectCommands(reason) {
      rejection = reason;
    },
    async close() {
      regulation.close();
      await coreBus.close();
      await perceptBus.close();
      await climBus.close();
      await broker.close();
    },
  };
}

/** Une seule pièce : la plupart des scénarios parlent d'un compresseur, pas de la maison. */
const salonSeul = (config: RegulationConfig): void => {
  delete config.rooms['entree'];
  delete config.rooms['chambre'];
  config.delestage.shed_order = [];
};

const decisionsOf = (events: RegulationEventData[], decision: string): RegulationEventData[] =>
  events.filter((event) => event.decision === decision);

/**
 * `evaluate()` rend la main dès que l'événement est **publié** ; sa livraison à un
 * abonné tiers reste asynchrone — d'où l'attente plutôt qu'une lecture directe.
 */
const awaitDecisions = async (
  world: World,
  decision: string,
  count: number,
): Promise<RegulationEventData[]> => {
  await vi.waitFor(() => expect(decisionsOf(world.events, decision)).toHaveLength(count));
  return decisionsOf(world.events, decision);
};

const cutTargets = (commands: Command[]): string[] =>
  commands.filter((cmd) => cmd.params['power'] === false).map((cmd) => cmd.target);

// ─────────────────────────────── les scénarios ───────────────────────────────

describe('runtime — un percept froid déclenche une commande, un état conforme n’en déclenche plus', () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld({
      start: JANVIER_15_14H,
      tune: salonSeul,
      // Court : c'est la publication du percept qui doit déclencher le tour.
      triggerDebounceMs: 25,
      seed: async (fixtures) => {
        await fixtures.seedClimate('clim_salon', 'salon', { power: false, targetTemp: 18 });
        await fixtures.seedClimate('thermostat_maison', 'salon', { power: true, targetTemp: 8 });
        await fixtures.seedTempo('bleu', 'bleu', 'HP');
        // Dans la bande morte : le monde de départ ne demande rien.
        await fixtures.seedTemperature('temp_salon', 'salon', 20.5);
      },
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('émet `set power true` vers le driver de la PAC et publie la décision', async () => {
    // 20.5 → 18.0 : sous consigne (20.5) − hystérésis (0.4).
    await world.seedTemperature('temp_salon', 'salon', 18.0);

    await vi.waitFor(() => expect(world.commands).toHaveLength(1));
    const [commande] = world.commands;
    expect(commande).toMatchObject({
      target: 'clim_salon',
      action: 'set',
      issuedBy: 'core',
    });
    expect(commande?.params).toEqual({ power: true, mode: 'heat', targetTemp: 20.5 });

    const [decision] = await awaitDecisions(world, 'pac_marche', 1);
    expect(decision?.room).toBe('salon');
    expect(decision?.cause.length).toBeGreaterThan(0);
    expect(decision?.cause).toContain('marche de clim_salon');
    expect(decision?.cause).toContain('20.5');
  });

  it('ne réémet rien quand la clim a rejoint la consigne (déduplication)', async () => {
    // Le faux driver a appliqué et republié : power true, consigne 20.5.
    await world.awaitClimate('clim_salon', { power: true, targetTemp: 20.5, mode: 'heat' });

    const avant = world.commands.length;
    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(avant);
    expect(world.regulation.lastOutcome?.decisions).toEqual([]);
  });
});

describe('runtime — anti-court-cycle : pas d’arrêt avant 5 min, arrêt après', () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld({
      start: JANVIER_15_14H,
      tune: salonSeul,
      // Aucun tour spontané : l'horloge et les tours sont pilotés par le test.
      triggerDebounceMs: NEVER,
      seed: async (fixtures) => {
        await fixtures.seedClimate('clim_salon', 'salon', { power: false, targetTemp: 18 });
        await fixtures.seedClimate('thermostat_maison', 'salon', { power: true, targetTemp: 8 });
        await fixtures.seedTempo('bleu', 'bleu', 'HP');
        await fixtures.seedTemperature('temp_salon', 'salon', 18.0);
      },
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('allume la PAC (t0)', async () => {
    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(1);
    expect(world.commands[0]?.params).toEqual({ power: true, mode: 'heat', targetTemp: 20.5 });
    await world.awaitClimate('clim_salon', { power: true });
  });

  it('à t0 + 4 min, la pièce repasse au-dessus de la bande : aucune commande', async () => {
    world.advanceMin(4);
    // 21.5 > consigne 20.5 + hystérésis 0.4.
    await world.seedTemperature('temp_salon', 'salon', 21.5);

    const avant = world.commands.length;
    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(avant);
    // La décision existe, mais elle est empêchée — donc ni commande ni événement.
    const differe = world.regulation.lastOutcome?.decisions.find(
      (decision) => decision.decision === 'arret_differe',
    );
    expect(differe?.severity).toBe('blocked');
    expect(differe?.cause).toContain('anti-court-cycle');
    expect(decisionsOf(world.events, 'arret_differe')).toHaveLength(0);
    expect(decisionsOf(world.events, 'pac_arret')).toHaveLength(0);
  });

  it('à t0 + 6 min, l’arrêt part', async () => {
    world.advanceMin(2);
    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(2);
    expect(world.commands[1]).toMatchObject({ target: 'clim_salon', issuedBy: 'core' });
    expect(world.commands[1]?.params).toEqual({ power: false });
    await world.awaitClimate('clim_salon', { power: false });

    const [arret] = await awaitDecisions(world, 'pac_arret', 1);
    expect(arret?.cause).toContain('arrêt de clim_salon');
  });
});

describe('runtime — jour rouge en heures pleines : PAC coupée, consigne au chauffage central', () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld({
      start: JANVIER_15_14H,
      tune: salonSeul,
      triggerDebounceMs: NEVER,
      seed: async (fixtures) => {
        // La PAC chauffe déjà quand la couleur du jour bascule.
        await fixtures.seedClimate('clim_salon', 'salon', { power: true, targetTemp: 20.5 });
        await fixtures.seedClimate('thermostat_maison', 'salon', { power: true, targetTemp: 8 });
        await fixtures.seedTempo('rouge', 'inconnue', 'HP');
        await fixtures.seedTemperature('temp_salon', 'salon', 18.0);
      },
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('coupe la PAC en citant le rouge et pousse la consigne au central', async () => {
    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(2);
    expect(world.commands[0]).toMatchObject({ target: 'clim_salon', issuedBy: 'core' });
    expect(world.commands[0]?.params).toEqual({ power: false });
    // Le chauffage central prend le relais : une consigne, jamais un arrêt.
    expect(world.commands[1]).toMatchObject({ target: 'thermostat_maison', issuedBy: 'core' });
    expect(world.commands[1]?.params).toEqual({ targetTemp: 20.5 });

    const [arret] = await awaitDecisions(world, 'pac_arret', 1);
    expect(arret?.cause).toContain('rouge');
    expect(arret?.cause).toContain('arrêt de clim_salon');
    const [consigne] = await awaitDecisions(world, 'central_consigne', 1);
    expect(consigne?.cause).toContain('rouge');
    expect(consigne?.cause).toContain('chauffage central');
  });

  it('ne rallume pas la PAC au tour suivant', async () => {
    await world.awaitClimate('clim_salon', { power: false });
    const avant = world.commands.length;

    await world.regulation.evaluate();

    expect(world.commands).toHaveLength(avant);
  });
});

describe('runtime — délestage puis réarmement', () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld({
      start: JANVIER_15_14H,
      // Configuration de production complète : trois pièces, trois PAC, un ordre
      // de sacrifice — c'est le sujet du scénario.
      triggerDebounceMs: NEVER,
      seed: async (fixtures) => {
        await fixtures.seedClimate('clim_salon', 'salon', { power: true, targetTemp: 20.5 });
        await fixtures.seedClimate('clim_entree', 'entree', { power: true, targetTemp: 19 });
        await fixtures.seedClimate('clim_chambre', 'chambre', { power: true, targetTemp: 19.5 });
        await fixtures.seedClimate('thermostat_maison', 'salon', { power: true, targetTemp: 8 });
        await fixtures.seedTempo('bleu', 'bleu', 'HP');
        // Chaque pièce est dans sa bande morte : rien à faire côté confort.
        await fixtures.seedTemperature('temp_salon', 'salon', 20.5);
        await fixtures.seedTemperature('temp_entree', 'entree', 19.0);
        await fixtures.seedTemperature('temp_chambre', 'chambre', 19.5);
        await fixtures.seedPower(1200);
      },
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('ne touche à rien tant que la puissance est basse', async () => {
    await world.regulation.evaluate();

    expect(world.commands).toEqual([]);
    expect(world.regulation.lastOutcome?.shed).toEqual([]);
  });

  it('coupe les PAC une par une dans l’ordre de `shed_order`', async () => {
    // 9400 VA > 9000 − 1000 : au-dessus du seuil de coupure.
    await world.seedPower(9400);

    await world.regulation.evaluate();
    await world.awaitClimate('clim_entree', { power: false });
    expect(cutTargets(world.commands)).toEqual(['clim_entree']);

    await world.regulation.evaluate();
    await world.awaitClimate('clim_chambre', { power: false });
    expect(cutTargets(world.commands)).toEqual(['clim_entree', 'clim_chambre']);

    await world.regulation.evaluate();
    await world.awaitClimate('clim_salon', { power: false });
    expect(cutTargets(world.commands)).toEqual(['clim_entree', 'clim_chambre', 'clim_salon']);

    expect(world.regulation.lastOutcome?.shed).toEqual([
      'clim_entree',
      'clim_chambre',
      'clim_salon',
    ]);

    const coupures = await awaitDecisions(world, 'delestage', 3);
    expect(coupures.map((decision) => decision.room)).toEqual(['maison', 'maison', 'maison']);
    for (const coupure of coupures) {
      expect(coupure.cause).toContain('VA');
      expect(coupure.cause).toContain('délestage de clim_');
    }
    // Le salon perd sa PAC mais garde la chaudière : la consigne y bascule.
    const [consigne] = await awaitDecisions(world, 'central_consigne', 1);
    expect(consigne?.cause).toContain('chauffage central');
  });

  it('ne réarme pas avant l’anti-court-cycle, puis réarme dans l’ordre inverse', async () => {
    // 6500 VA < 7000 : sous le seuil de réarmement, mais les bascules datent d'il
    // y a zéro minute.
    await world.seedPower(6500);
    await world.regulation.evaluate();

    expect(decisionsOf(world.events, 'rearmement')).toHaveLength(0);
    const differe = world.regulation.lastOutcome?.decisions.find(
      (decision) => decision.decision === 'rearmement_differe',
    );
    expect(differe?.severity).toBe('blocked');
    expect(world.regulation.lastOutcome?.shed).toHaveLength(3);

    world.advanceMin(6);
    await world.regulation.evaluate();
    await world.regulation.evaluate();
    await world.regulation.evaluate();

    expect(world.regulation.lastOutcome?.shed).toEqual([]);
    const rearmements = await awaitDecisions(world, 'rearmement', 3);
    for (const rearmement of rearmements) {
      expect(rearmement.cause).toContain('seuil de réarmement');
    }
    // Dernier coupé, premier rendu au thermostat.
    expect(rearmements[0]?.cause).toContain('clim_salon');
    expect(rearmements[1]?.cause).toContain('clim_chambre');
    expect(rearmements[2]?.cause).toContain('clim_entree');
  });
});

describe('runtime — ack `rejected` : la décision est publiée, le tour ne casse pas', () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld({
      start: JANVIER_15_14H,
      tune: salonSeul,
      triggerDebounceMs: NEVER,
      seed: async (fixtures) => {
        await fixtures.seedClimate('clim_salon', 'salon', { power: false, targetTemp: 18 });
        await fixtures.seedClimate('thermostat_maison', 'salon', { power: true, targetTemp: 8 });
        await fixtures.seedTempo('bleu', 'bleu', 'HP');
        await fixtures.seedTemperature('temp_salon', 'salon', 18.0);
      },
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('journalise l’échec et publie quand même la décision', async () => {
    world.rejectCommands('compresseur en défaut');

    // Le tour se termine normalement : un ack négatif n'est pas une exception.
    await expect(world.regulation.evaluate()).resolves.toMatchObject({ now: JANVIER_15_14H });

    expect(world.commands).toHaveLength(1);
    const refus = world.warnings.find(
      (warning) => warning.msg === 'commande de régulation non acquittée',
    );
    expect(refus?.extra).toMatchObject({
      target: 'clim_salon',
      decision: 'pac_marche',
      status: 'rejected',
      reason: 'compresseur en défaut',
    });

    // La décision est publiée malgré tout — et l'échec matériel voyage AVEC elle
    // (champ `commandFailure`) : le journal permet de relire aussi les refus.
    const [decision] = await awaitDecisions(world, 'pac_marche', 1);
    expect(decision?.commandFailure).toEqual({
      status: 'rejected',
      reason: 'compresseur en défaut',
    });
    expect(world.events.every((event) => event.decision !== 'pac_marche_echec')).toBe(true);
  });

  it('ne réessaie pas avant l’anti-court-cycle (la bascule est comptée à l’émission)', async () => {
    await world.regulation.evaluate();
    expect(world.commands).toHaveLength(1);

    world.advanceMin(6);
    await world.regulation.evaluate();
    expect(world.commands).toHaveLength(2);
    expect(world.commands[1]?.params).toEqual({ power: true, mode: 'heat', targetTemp: 20.5 });
  });
});
