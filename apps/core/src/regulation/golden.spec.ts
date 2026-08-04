import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { ClimateMode } from '@stellar/contracts';
import { decide } from './decide.js';
import { loadRegulationConfig, type RegulationConfig } from './regulation-config.js';
import { derivePeriode, localTime, WEEKDAY_LABELS } from './time.js';
import type {
  ActuatorRole,
  ActuatorState,
  Decision,
  Outcome,
  PresenceReading,
  RoomEvaluation,
  RoomSnapshot,
  SensorReading,
  Snapshot,
} from './types.js';

/**
 * GOLDEN TESTS DE RÉGULATION (docs/TESTING.md §2.3, DoD P6).
 *
 * Chaque scénario déroule une « journée type » **heure par heure** à travers la
 * fonction pure `decide`, et rend le résultat en texte : l'état de chaque pièce,
 * puis les décisions prises avec leur cause. Le fichier produit est comparé au
 * golden committé — un changement de comportement devient un diff lisible par un
 * humain, ce que ne donnerait jamais un `expect(...).toEqual(...)`.
 *
 * Régénération après un changement assumé : `UPDATE_GOLDEN=1 pnpm --filter
 * @stellar/core test`. Le diff qui apparaît dans la PR **est** la revue.
 *
 * La configuration utilisée est celle de production (`config/regulation.yaml`) :
 * les goldens valident donc aussi les réglages livrés.
 */

const GOLDEN_DIR = fileURLToPath(new URL('golden/', import.meta.url));
const PROD_CONFIG = fileURLToPath(new URL('../../../../config/regulation.yaml', import.meta.url));

// ───────────────────────────── monde simulé ─────────────────────────────

interface WorldActuator {
  power: boolean;
  targetTemp: number;
  mode?: ClimateMode;
  indoorTemp?: number;
  known?: boolean;
  stale?: boolean;
  driverOnline?: boolean;
}

interface World {
  /** Capteur de température par pièce (`null` = capteur absent du miroir). */
  temps: Record<string, { value: number; stale?: boolean } | null>;
  presence: Record<string, { value: boolean; ts: number; stale?: boolean }>;
  tempo?: {
    couleurJour: 'bleu' | 'blanc' | 'rouge';
    couleurDemain: 'bleu' | 'blanc' | 'rouge' | 'inconnue';
    /** Absent = déduite de l'heure locale (HP 6 h–22 h). */
    periode?: 'HP' | 'HC';
    stale?: boolean;
  };
  power?: { va: number; stale?: boolean };
  actuators: Record<string, WorldActuator>;
}

interface ScenarioEvent {
  /** Minutes après le début du scénario. */
  atMin: number;
  /** Affiché dans le golden : c'est le récit du scénario. */
  label: string;
  apply: (world: World) => void;
}

interface Scenario {
  slug: string;
  title: string;
  description: string;
  /** Epoch ms — toujours donné en UTC, avec l'heure locale en commentaire. */
  start: number;
  stepMin: number;
  steps: number;
  /** Ajustements de la config de production (pièces retirées, seuils…). */
  tune?: (config: RegulationConfig) => void;
  world: World;
  /** Température par pièce, une valeur par pas ; la dernière se répète. */
  series?: Record<string, number[]>;
  events?: ScenarioEvent[];
}

interface Memory {
  shed: string[];
  alerts: string[];
  lastPowerChangeAt: Record<string, number>;
}

function toActuator(
  world: World,
  entityId: string | undefined,
  role: ActuatorRole,
): ActuatorState | undefined {
  if (entityId === undefined) return undefined;
  const raw = world.actuators[entityId];
  if (!raw) {
    return {
      entityId,
      role,
      known: false,
      stale: true,
      driverOnline: false,
      power: false,
      mode: 'heat',
      targetTemp: 0,
    };
  }
  return {
    entityId,
    role,
    known: raw.known ?? true,
    stale: raw.stale ?? false,
    driverOnline: raw.driverOnline ?? true,
    power: raw.power,
    mode: raw.mode ?? 'heat',
    targetTemp: raw.targetTemp,
    ...(raw.indoorTemp !== undefined ? { indoorTemp: raw.indoorTemp } : {}),
  };
}

function toSnapshot(world: World, config: RegulationConfig, memory: Memory, now: number): Snapshot {
  const rooms: RoomSnapshot[] = Object.entries(config.rooms).map(([room, roomConfig]) => {
    const reading = world.temps[room];
    // Le premier capteur déclaré porte la mesure de la pièce ; les suivants (il
    // n'y en a pas aujourd'hui) sont réputés absents du miroir.
    const sensors: SensorReading[] = roomConfig.sensors.map((entityId, index) =>
      index === 0 && reading
        ? { entityId, value: reading.value, stale: reading.stale === true }
        : { entityId, value: Number.NaN, stale: true },
    );
    const seen = world.presence[room];
    const presence: PresenceReading[] = seen
      ? [
          {
            entityId: `presence_${room}`,
            value: seen.value,
            ts: seen.ts,
            stale: seen.stale === true,
          },
        ]
      : [];
    const pac = toActuator(world, roomConfig.actuators.pac, 'pac');
    const central = toActuator(world, roomConfig.actuators.central, 'central');
    return {
      room,
      sensors,
      presence,
      ...(pac ? { pac } : {}),
      ...(central ? { central } : {}),
    };
  });

  const local = localTime(now, config.timezone);
  return {
    rooms,
    ...(world.tempo
      ? {
          tempo: {
            entityId: 'tempo_jour',
            couleurJour: world.tempo.couleurJour,
            couleurDemain: world.tempo.couleurDemain,
            periode: world.tempo.periode ?? derivePeriode(local.minutesOfDay),
            stale: world.tempo.stale === true,
          },
        }
      : {}),
    ...(world.power
      ? {
          power: {
            entityId: 'power_maison',
            va: world.power.va,
            stale: world.power.stale === true,
          },
        }
      : {}),
    shed: memory.shed,
    alerts: memory.alerts,
    lastPowerChangeAt: memory.lastPowerChangeAt,
  };
}

/** Boucle fermée : ce que la régulation commande devient l'état du monde. */
function applyToWorld(world: World, outcome: Outcome, now: number, memory: Memory): void {
  for (const decision of outcome.decisions) {
    const command = decision.command;
    if (!command) continue;
    const actuator = world.actuators[command.target];
    if (!actuator) continue;
    if (command.params.power !== undefined) {
      actuator.power = command.params.power;
      memory.lastPowerChangeAt[command.target] = now;
    }
    if (command.params.mode !== undefined) actuator.mode = command.params.mode;
    if (command.params.targetTemp !== undefined) actuator.targetTemp = command.params.targetTemp;
  }
}

// ─────────────────────────────── rendu texte ───────────────────────────────

const SEVERITY_MARK: Record<Decision['severity'], string> = {
  action: '→',
  alert: '!',
  blocked: '·',
};

function renderRoom(evaluation: RoomEvaluation): string {
  const name = evaluation.room.padEnd(8);
  const temp =
    evaluation.temperature === undefined
      ? '   —  '
      : `${evaluation.temperature.toFixed(1).padStart(5)} °C`;
  const source = evaluation.temperatureSource ?? 'aucune mesure';
  const chosen = evaluation.chosen ?? 'aucun';
  return (
    `  ${name} ${temp} (${source}) · ${evaluation.mode} · ` +
    `consigne ${evaluation.setpoint.toFixed(1)}${evaluation.preheat ? ' (préchauffe)' : ''} · ${chosen}`
  );
}

function renderDecision(decision: Decision): string[] {
  const lines = [
    `    ${SEVERITY_MARK[decision.severity]} ${decision.room}/${decision.decision} : ${decision.cause}`,
  ];
  if (decision.command) {
    lines.push(
      `      cmd ${decision.command.target} ${decision.command.action} ${JSON.stringify(decision.command.params)}`,
    );
  }
  return lines;
}

function renderStep(outcome: Outcome, world: World): string[] {
  const { local, energy } = outcome;
  const day = WEEKDAY_LABELS[local.weekday] ?? '???';
  const hhmm = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const couleur = world.tempo
    ? `${world.tempo.couleurJour}→${world.tempo.couleurDemain}${world.tempo.stale === true ? ' (stale)' : ''}`
    : 'indisponible';
  const puissance = world.power
    ? ` · ${Math.round(world.power.va)} VA${world.power.stale === true ? ' (stale)' : ''}`
    : '';
  const shed = outcome.shed.length > 0 ? ` · délestés: ${outcome.shed.join(', ')}` : '';

  const lines = [
    `${local.date} ${hhmm} (${day}) · couleur ${couleur} · ${energy.periode}${puissance}${shed}`,
  ];
  for (const evaluation of outcome.rooms) lines.push(renderRoom(evaluation));
  for (const decision of outcome.decisions) lines.push(...renderDecision(decision));
  return lines;
}

function runScenario(scenario: Scenario): string {
  const config = loadRegulationConfig(PROD_CONFIG);
  scenario.tune?.(config);

  const world = structuredClone(scenario.world);
  const memory: Memory = { shed: [], alerts: [], lastPowerChangeAt: {} };
  const events = [...(scenario.events ?? [])].sort((a, b) => a.atMin - b.atMin);
  let nextEvent = 0;

  const header = [
    `# scénario : ${scenario.title}`,
    ...scenario.description.split('\n').map((line) => `# ${line}`),
    `# config : hystérésis ${config.hysteresis} °C · nuit ${config.night.start}→${config.night.end} ·`,
    `#          anti-court-cycle ${config.anti_short_cycle_min} min · présence ${config.presence_timeout_min} min ·`,
    `#          délestage ${config.delestage.max_va}/${config.delestage.margin_va}/${config.delestage.rearm_va} VA` +
      ` [${config.delestage.shed_order.join(', ')}]`,
    `#          préchauffe dès ${config.energy.preheat_before_red.start} (+${config.energy.preheat_before_red.delta} °C)`,
    `# pas de ${scenario.stepMin} min · ${scenario.steps} pas · fuseau ${config.timezone}`,
    '',
  ];

  const body: string[] = [];
  for (let step = 0; step < scenario.steps; step += 1) {
    const now = scenario.start + step * scenario.stepMin * 60_000;

    while (
      nextEvent < events.length &&
      (events[nextEvent]?.atMin ?? 0) <= step * scenario.stepMin
    ) {
      const event = events[nextEvent];
      nextEvent += 1;
      if (!event) continue;
      event.apply(world);
      body.push(`>>> ${event.label}`);
    }

    for (const [room, values] of Object.entries(scenario.series ?? {})) {
      const value = values[Math.min(step, values.length - 1)];
      const current = world.temps[room];
      if (value !== undefined && current) current.value = value;
    }

    const outcome = decide(toSnapshot(world, config, memory, now), config, now);
    memory.shed = outcome.shed;
    memory.alerts = outcome.alerts;
    applyToWorld(world, outcome, now, memory);

    body.push(...renderStep(outcome, world), '');
  }

  return [...header, ...body].join('\n');
}

// ──────────────────────────────── scénarios ────────────────────────────────

const climat = (targetTemp: number, indoorTemp: number): WorldActuator => ({
  power: false,
  targetTemp,
  mode: 'heat',
  indoorTemp,
});

/** 2026-01-15 00:00 heure locale (Europe/Paris, UTC+1 en janvier). */
const JANVIER_15_MINUIT = Date.UTC(2026, 0, 14, 23, 0);
const heures = (n: number): number => n * 60;

const scenarios: Scenario[] = [
  {
    slug: '01-journee-bleue',
    title: 'journée bleue nominale',
    description:
      "Une journée sans histoire : la nuit, le réveil, le départ au travail, le retour.\nElle exerce la bascule nuit/jour, la temporisation de présence et l'hystérésis\ndans les deux sens — plus la non-émission de commande quand rien ne change.",
    start: JANVIER_15_MINUIT,
    stepMin: 60,
    steps: 24,
    world: {
      temps: { salon: { value: 18.2 }, entree: { value: 17.6 }, chambre: { value: 18.1 } },
      // Présence vue fausse depuis la veille : le salon démarre inoccupé.
      presence: { salon: { value: false, ts: JANVIER_15_MINUIT - heures(6) * 60_000 } },
      tempo: { couleurJour: 'bleu', couleurDemain: 'bleu' },
      power: { va: 900 },
      actuators: {
        clim_salon: climat(18, 18.2),
        clim_entree: climat(17.5, 17.6),
        clim_chambre: climat(18, 18.1),
        thermostat_maison: { power: true, targetTemp: 16, mode: 'heat' },
      },
    },
    series: {
      // 00 h → 23 h
      salon: [
        18.2, 17.5, 17.9, 18.3, 18.6, 18.2, 17.9, 17.8, 19.5, 20.4, 20.6, 20.2, 19.8, 19.5, 19.2,
        18.9, 18.6, 18.3, 18.0, 19.4, 20.5, 20.6, 21.0, 20.6,
      ],
      entree: [
        17.6, 17.4, 17.0, 17.3, 17.6, 17.4, 17.1, 16.9, 17.6, 18.4, 18.9, 19.2, 19.5, 19.3, 19.0,
        18.7, 18.4, 18.2, 18.6, 19.0, 19.3, 19.5, 19.2, 18.8,
      ],
      chambre: [
        18.1, 17.8, 17.5, 17.9, 18.2, 18.4, 18.1, 17.9, 18.5, 19.2, 19.7, 19.9, 19.6, 19.3, 19.0,
        18.8, 18.6, 18.4, 18.9, 19.4, 19.8, 20.0, 19.6, 19.2,
      ],
    },
    events: [
      {
        atMin: heures(7),
        label: 'réveil : le capteur de présence du salon passe à vrai',
        apply: (world) => {
          world.presence['salon'] = { value: true, ts: JANVIER_15_MINUIT + heures(7) * 60_000 };
        },
      },
      {
        atMin: heures(9),
        label: 'départ : présence fausse — la pièce reste « occupée » 30 min (temporisation)',
        apply: (world) => {
          world.presence['salon'] = { value: false, ts: JANVIER_15_MINUIT + heures(9) * 60_000 };
        },
      },
      {
        atMin: heures(18),
        label: 'retour à la maison',
        apply: (world) => {
          world.presence['salon'] = { value: true, ts: JANVIER_15_MINUIT + heures(18) * 60_000 };
        },
      },
    ],
  },

  {
    slug: '02-tempo-rouge',
    title: 'demain rouge : préchauffe nocturne puis journée rouge',
    description:
      "Le jour Tempo court de 6 h à 6 h : « demain rouge » devient « aujourd'hui rouge »\nà 6 h du matin. On préchauffe donc pendant les heures creuses (dès 2 h, +1 °C),\npuis les PAC sont interdites de 6 h à 22 h — le salon bascule sur la chaudière,\nles deux pièces qui n'en ont pas subissent. À 22 h les heures creuses reviennent\net les PAC avec.",
    start: Date.UTC(2026, 0, 15, 0, 0), // 2026-01-15 01:00 locale
    stepMin: 60,
    steps: 23,
    world: {
      temps: { salon: { value: 17.9 }, entree: { value: 17.2 }, chambre: { value: 17.8 } },
      presence: {},
      // Annoncée la veille vers 11 h par RTE.
      tempo: { couleurJour: 'bleu', couleurDemain: 'rouge' },
      power: { va: 1100 },
      actuators: {
        clim_salon: climat(18, 17.9),
        clim_entree: climat(17.5, 17.2),
        clim_chambre: climat(18, 17.8),
        thermostat_maison: { power: true, targetTemp: 16, mode: 'heat' },
      },
    },
    series: {
      // 01 h → 23 h
      salon: [
        17.9, 17.6, 18.2, 18.8, 19.3, 19.6, 19.4, 19.8, 20.2, 20.6, 20.9, 21.1, 20.8, 20.5, 20.2,
        20.0, 19.8, 19.6, 19.4, 19.2, 19.0, 18.8, 19.2,
      ],
      entree: [
        17.2, 17.0, 17.4, 17.9, 18.3, 18.6, 18.4, 18.2, 18.0, 17.8, 17.6, 17.4, 17.2, 17.0, 16.8,
        16.6, 16.5, 16.3, 16.2, 16.0, 15.9, 15.8, 16.4,
      ],
      chambre: [
        17.8, 17.5, 18.0, 18.5, 18.9, 19.2, 19.0, 18.8, 18.6, 18.4, 18.2, 18.0, 17.8, 17.6, 17.4,
        17.2, 17.1, 16.9, 16.8, 16.6, 16.5, 16.4, 17.0,
      ],
    },
    events: [
      {
        atMin: heures(5), // 06:00 locale
        label: 'RTE : le jour Tempo bascule — aujourd’hui rouge, heures pleines',
        apply: (world) => {
          world.tempo = { couleurJour: 'rouge', couleurDemain: 'inconnue' };
        },
      },
      {
        atMin: heures(10), // 11:00 locale
        label: 'RTE publie la couleur du lendemain : bleu',
        apply: (world) => {
          if (world.tempo) world.tempo.couleurDemain = 'bleu';
        },
      },
    ],
  },

  {
    slug: '03-capteur-stale',
    title: 'capteur muet : repli sur la clim, puis hors-gel',
    description:
      "Le capteur du salon se tait (pile morte, le core l'a marqué stale) : la\nrégulation bascule sur la température intérieure de la clim. Puis la clim se\ntait à son tour — plus aucune mesure : consigne hors-gel, PAC à l'arrêt, alerte\nune seule fois. Le retour du capteur remet tout en place. Les deux autres pièces\ncontinuent normalement.",
    start: Date.UTC(2026, 0, 15, 7, 0), // 2026-01-15 08:00 locale
    stepMin: 30,
    steps: 10,
    world: {
      temps: { salon: { value: 19.0 }, entree: { value: 18.6 }, chambre: { value: 19.0 } },
      presence: {},
      tempo: { couleurJour: 'bleu', couleurDemain: 'bleu' },
      power: { va: 1400 },
      actuators: {
        clim_salon: climat(20.5, 18.8),
        clim_entree: climat(19, 18.6),
        clim_chambre: climat(19.5, 19.0),
        thermostat_maison: { power: true, targetTemp: 16, mode: 'heat' },
      },
    },
    series: {
      salon: [19.0, 18.8, 18.6, 18.5, 18.4, 18.4, 18.5, 18.6, 18.8, 19.0],
      entree: [18.6, 18.5, 18.4, 18.6, 18.8, 19.0, 19.2, 19.3, 19.4, 19.4],
      chambre: [19.0, 18.9, 18.8, 18.9, 19.1, 19.3, 19.5, 19.7, 19.9, 20.0],
    },
    events: [
      {
        atMin: 60,
        label: 'temp_salon marqué stale → repli sur clim_salon.indoorTemp',
        apply: (world) => {
          const salon = world.temps['salon'];
          if (salon) salon.stale = true;
        },
      },
      {
        atMin: 120,
        label: 'clim_salon devient muette à son tour → plus aucune mesure',
        apply: (world) => {
          const clim = world.actuators['clim_salon'];
          if (clim) clim.stale = true;
        },
      },
      {
        atMin: 240,
        label: 'pile changée : temp_salon et clim_salon reparlent',
        apply: (world) => {
          const salon = world.temps['salon'];
          if (salon) salon.stale = false;
          const clim = world.actuators['clim_salon'];
          if (clim) clim.stale = false;
        },
      },
    ],
  },

  {
    slug: '04-delestage',
    title: 'délestage : pic de puissance, coupures et réarmement',
    description:
      "Le four et la plaque s'ajoutent aux trois PAC : la puissance dépasse\n9000 − 1000 VA. Les PAC sont coupées une par une dans l'ordre configuré\n(entrée, chambre, salon), puis réarmées dans l'ordre inverse quand la\npuissance retombe sous 7000 VA — en respectant l'anti-court-cycle.\nLe salon, lui, bascule sur la chaudière pendant sa coupure.",
    start: Date.UTC(2026, 0, 15, 17, 0), // 2026-01-15 18:00 locale
    stepMin: 1,
    steps: 26,
    world: {
      temps: { salon: { value: 19.4 }, entree: { value: 18.0 }, chambre: { value: 18.6 } },
      presence: {},
      tempo: { couleurJour: 'bleu', couleurDemain: 'bleu' },
      power: { va: 4200 },
      actuators: {
        clim_salon: { power: true, targetTemp: 20.5, mode: 'heat', indoorTemp: 19.4 },
        clim_entree: { power: true, targetTemp: 19, mode: 'heat', indoorTemp: 18.0 },
        clim_chambre: { power: true, targetTemp: 19.5, mode: 'heat', indoorTemp: 18.6 },
        thermostat_maison: { power: true, targetTemp: 8, mode: 'heat' },
      },
    },
    events: [
      {
        atMin: 3,
        label: 'four + plaque induction : 9400 VA',
        apply: (world) => {
          world.power = { va: 9400 };
        },
      },
      {
        atMin: 4,
        label: 'la coupure de l’entrée ne suffit pas',
        apply: (world) => {
          world.power = { va: 8600 };
        },
      },
      {
        atMin: 5,
        label: 'la coupure de la chambre ne suffit toujours pas',
        apply: (world) => {
          world.power = { va: 8200 };
        },
      },
      {
        atMin: 6,
        label: 'les trois PAC coupées : la puissance redescend',
        apply: (world) => {
          world.power = { va: 7400 };
        },
      },
      {
        atMin: 8,
        label: 'plaque éteinte : 6500 VA, sous le seuil de réarmement',
        apply: (world) => {
          world.power = { va: 6500 };
        },
      },
    ],
  },

  {
    slug: '05-anti-court-cycle',
    title: 'anti-court-cycle : consigne oscillante, une bascule par 5 min',
    description:
      "Un capteur qui oscille de part et d'autre de la bande morte toutes les deux\nminutes (courant d'air, soleil rasant). Sans garde-fou le compresseur\nbasculerait à chaque pas ; ici il ne bascule jamais plus d'une fois par 5 min,\nles autres tentatives étant tracées comme différées.",
    start: Date.UTC(2026, 0, 15, 13, 0), // 2026-01-15 14:00 locale
    stepMin: 2,
    steps: 16,
    tune: (config) => {
      // Une seule pièce : le scénario parle du compresseur, pas de la maison.
      delete config.rooms['entree'];
      delete config.rooms['chambre'];
      config.delestage.shed_order = [];
    },
    world: {
      temps: { salon: { value: 19.9 } },
      presence: { salon: { value: true, ts: Date.UTC(2026, 0, 15, 13, 0) } },
      tempo: { couleurJour: 'bleu', couleurDemain: 'bleu' },
      power: { va: 2000 },
      actuators: {
        clim_salon: { power: false, targetTemp: 20.5, mode: 'heat', indoorTemp: 19.9 },
        thermostat_maison: { power: true, targetTemp: 8, mode: 'heat' },
      },
    },
    series: {
      salon: [19.9, 21.2, 19.9, 21.2, 19.9, 21.2, 19.9, 21.2, 19.9, 21.2, 19.9, 21.2, 19.9, 21.2],
    },
  },

  {
    slug: '06-driver-offline',
    title: 'driver hors ligne : silence et alerte unique',
    description:
      "Le process qui pilote les clims meurt (LWT « offline »). Aucune commande ne\npart plus vers ses entités, même quand la température s'effondre : une alerte,\nune seule, et le silence. Le salon garde sa chaudière ; les deux autres pièces\nn'ont plus rien. Tout repart au retour du driver.",
    start: Date.UTC(2026, 0, 15, 8, 0), // 2026-01-15 09:00 locale
    stepMin: 30,
    steps: 8,
    world: {
      temps: { salon: { value: 19.6 }, entree: { value: 18.8 }, chambre: { value: 19.3 } },
      presence: {},
      tempo: { couleurJour: 'bleu', couleurDemain: 'bleu' },
      power: { va: 2600 },
      actuators: {
        clim_salon: { power: true, targetTemp: 20.5, mode: 'heat', indoorTemp: 19.6 },
        clim_entree: { power: true, targetTemp: 19, mode: 'heat', indoorTemp: 18.8 },
        clim_chambre: { power: true, targetTemp: 19.5, mode: 'heat', indoorTemp: 19.3 },
        thermostat_maison: { power: true, targetTemp: 8, mode: 'heat' },
      },
    },
    series: {
      salon: [19.6, 19.4, 19.0, 18.6, 18.2, 17.8, 17.6, 17.4],
      entree: [18.8, 18.6, 18.2, 17.8, 17.4, 17.0, 16.8, 16.6],
      chambre: [19.3, 19.1, 18.7, 18.3, 17.9, 17.5, 17.3, 17.1],
    },
    events: [
      {
        atMin: 60,
        label: 'le driver des clims passe hors ligne (LWT)',
        apply: (world) => {
          for (const id of ['clim_salon', 'clim_entree', 'clim_chambre']) {
            const actuator = world.actuators[id];
            if (actuator) actuator.driverOnline = false;
          }
        },
      },
      {
        atMin: 180,
        label: 'le driver redémarre',
        apply: (world) => {
          for (const id of ['clim_salon', 'clim_entree', 'clim_chambre']) {
            const actuator = world.actuators[id];
            if (actuator) actuator.driverOnline = true;
          }
        },
      },
    ],
  },
];

// ───────────────────────────────── le test ─────────────────────────────────

/** Git normalise en LF (.gitattributes) ; Windows peut rendre du CRLF au checkout. */
const normalize = (text: string): string => text.replace(/\r\n/g, '\n').trimEnd();

describe('golden tests de régulation', () => {
  const update = process.env.UPDATE_GOLDEN === '1';

  for (const scenario of scenarios) {
    it(scenario.title, () => {
      const produced = runScenario(scenario);
      const path = `${GOLDEN_DIR}${scenario.slug}.txt`;

      if (update) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, `${normalize(produced)}\n`, 'utf8');
        return;
      }

      let expected: string;
      try {
        expected = readFileSync(path, 'utf8');
      } catch {
        throw new Error(
          `golden manquant : ${path}\nRégénérer avec UPDATE_GOLDEN=1 pnpm --filter @stellar/core test`,
        );
      }
      // Comparaison ligne à ligne : le diff de vitest reste lisible sur 200 lignes.
      expect(normalize(produced).split('\n')).toEqual(normalize(expected).split('\n'));
    });
  }

  it('rejoue deux fois le même scénario à l’identique (déterminisme)', () => {
    const scenario = scenarios[0];
    expect(scenario).toBeDefined();
    if (!scenario) return;
    expect(runScenario(scenario)).toBe(runScenario(scenario));
  });
});
