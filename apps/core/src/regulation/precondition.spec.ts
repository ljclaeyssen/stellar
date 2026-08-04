import { describe, expect, it } from 'vitest';
import type { JournalRow } from '../journal.js';
import { buildOccupancyProfile, type OccupancyProfile } from '../predictive/occupancy.js';
import { decide } from './decide.js';
import { evaluatePreconditioning, type PreconditioningInput } from './precondition.js';
import {
  parseRegulationConfig,
  type RegulationConfig,
  type Setpoints,
} from './regulation-config.js';
import type { EnergyEvaluation, Snapshot } from './types.js';

/**
 * PRÉCONDITIONNEMENT PRÉDICTIF (P9) — la règle et ses trois interdits.
 *
 * Les goldens racontent une journée ; ce fichier vérifie les gardes une par une,
 * y compris les combinaisons qu'un scénario ne croise jamais. Le DoD P9 exige
 * « sans hausse de conso les jours rouges » : c'est ici que ça se prouve au cas
 * par cas, et dans `golden/07-preconditionnement.txt` que ça se relit.
 */

const TZ = 'Europe/Paris';
const DAY = 86_400_000;
const HALF_HOUR = 1_800_000;
/** 2026-01-15 00:00 heure locale (Europe/Paris, UTC+1 en janvier) — un jeudi. */
const JEUDI_MINUIT = Date.UTC(2026, 0, 14, 23, 0);
const jeudi = (minutes: number): number => JEUDI_MINUIT + minutes * 60_000;
/** Jeudi 17:45 : dans 45 min il sera 18:30, l'heure où le salon se remplit. */
const JEUDI_17H45 = jeudi(17 * 60 + 45);

// ───────────────────────────── profil de référence ─────────────────────────────

/** Quatre semaines de mmWave : le salon est occupé chaque soir dès 18:30. */
function profilSoiree(): OccupancyProfile {
  const rows: JournalRow[] = [];
  let id = 0;
  for (let day = 1; day <= 28; day += 1) {
    const midnight = JEUDI_MINUIT - day * DAY;
    for (let slot = 0; slot < 48; slot += 1) {
      const ts = new Date(midnight + slot * HALF_HOUR).toISOString();
      id += 1;
      const occupied = slot >= 37 && slot < 46; // 18:30 → 23:00
      rows.push({
        id,
        ts,
        topic: 'home/state/fakepercepts/presence_salon',
        driver: 'fakepercepts',
        entityId: 'presence_salon',
        kind: 'presence',
        payload: JSON.stringify({
          id: 'presence_salon',
          driver: 'fakepercepts',
          kind: 'presence',
          room: 'salon',
          value: occupied,
          ts,
        }),
        issuedBy: null,
      });
    }
  }
  return buildOccupancyProfile(rows, { now: JEUDI_17H45, timezone: TZ });
}

const PROFIL = profilSoiree();

// ──────────────────────────── la règle, isolée ────────────────────────────

const SETPOINTS: Setpoints = { present: 20.5, absent: 17, nuit: 18, hors_gel: 8 };

const energie = (over: Partial<EnergyEvaluation> = {}): EnergyEvaluation => ({
  periode: 'HP',
  couleurJour: 'bleu',
  couleurDemain: 'bleu',
  pacAllowed: true,
  preferred: 'pac',
  preheatDelta: 0,
  source: 'percept',
  label: 'jour bleu HP',
  ...over,
});

const entree = (over: Partial<PreconditioningInput> = {}): PreconditioningInput => ({
  room: 'salon',
  mode: 'absent',
  degraded: false,
  setpoints: SETPOINTS,
  baseSetpoint: SETPOINTS.absent,
  energy: energie(),
  profile: PROFIL,
  config: { enabled: true, lookahead_min: 45, threshold: 0.6, max_delta: 1 },
  timezone: TZ,
  now: JEUDI_17H45,
  shedding: false,
  ...over,
});

describe('préconditionnement — la préchauffe douce', () => {
  it('relève la consigne « absent » vers « présent », plafonnée par max_delta', () => {
    const outcome = evaluatePreconditioning(entree());
    expect(outcome?.setpoint).toBe(18);
    expect(outcome?.horizon).toBe('18:30');
    expect(outcome?.probability).toBeGreaterThan(0.9);
    expect(outcome?.refusal).toBeUndefined();
    expect(outcome?.cause).toContain('occupation probable à 18:30');
    expect(outcome?.cause).toContain('18.0 °C au lieu de 17.0 °C');
  });

  it('ne dépasse jamais la consigne « présent », même avec un gros delta', () => {
    const outcome = evaluatePreconditioning(
      entree({ config: { enabled: true, lookahead_min: 45, threshold: 0.6, max_delta: 5 } }),
    );
    expect(outcome?.setpoint).toBe(20.5);
  });

  it('se tait quand la règle ne s’applique pas', () => {
    // Éteinte, sans profil, hors du mode `absent`, ou sans mesure exploitable.
    expect(
      evaluatePreconditioning(
        entree({ config: { enabled: false, lookahead_min: 45, threshold: 0.6, max_delta: 1 } }),
      ),
    ).toBeUndefined();
    expect(evaluatePreconditioning(entree({ profile: undefined }))).toBeUndefined();
    expect(evaluatePreconditioning(entree({ mode: 'present' }))).toBeUndefined();
    expect(evaluatePreconditioning(entree({ mode: 'nuit' }))).toBeUndefined();
    expect(evaluatePreconditioning(entree({ degraded: true, mode: 'hors_gel' }))).toBeUndefined();
  });

  it('se tait quand le profil ne sait pas, ou dit « vide »', () => {
    // Pièce inconnue du profil : « je ne sais pas » n'autorise rien.
    expect(evaluatePreconditioning(entree({ room: 'chambre' }))).toBeUndefined();
    // 10:00 + 45 min : le salon est vide à cette heure-là.
    expect(evaluatePreconditioning(entree({ now: jeudi(10 * 60) }))).toBeUndefined();
    // Le seuil fait son office : p ≈ 0,96 ne suffit pas si on exige 0,99.
    expect(
      evaluatePreconditioning(
        entree({ config: { enabled: true, lookahead_min: 45, threshold: 0.99, max_delta: 1 } }),
      ),
    ).toBeUndefined();
  });

  it('se tait quand la hausse serait nulle (consigne absent déjà au-dessus)', () => {
    const outcome = evaluatePreconditioning(
      entree({ setpoints: { ...SETPOINTS, present: 17 }, baseSetpoint: 17 }),
    );
    expect(outcome).toBeUndefined();
  });

  it('dépend de l’horizon, pas de l’heure courante', () => {
    // 17:00 → horizon 17:45, le salon est encore vide : rien.
    expect(evaluatePreconditioning(entree({ now: jeudi(17 * 60) }))).toBeUndefined();
    // Même instant, horizon porté à 90 min → 18:30 : la règle s'applique.
    expect(
      evaluatePreconditioning(
        entree({
          now: jeudi(17 * 60),
          config: { enabled: true, lookahead_min: 90, threshold: 0.6, max_delta: 1 },
        }),
      )?.setpoint,
    ).toBe(18);
  });
});

describe('préconditionnement — les trois interdits (DoD P9)', () => {
  it('jamais un jour rouge en heures pleines', () => {
    const outcome = evaluatePreconditioning(
      entree({ energy: energie({ couleurJour: 'rouge', periode: 'HP', pacAllowed: false }) }),
    );
    expect(outcome?.setpoint).toBeUndefined();
    expect(outcome?.refusal).toBe('rouge_hp');
    expect(outcome?.cause).toContain('jour rouge en heures pleines');
    // Le refus reste explicable : il porte l'observation qui l'a motivé.
    expect(outcome?.cause).toContain('occupation probable à 18:30');
  });

  it('mais autorisé un jour rouge en heures creuses (la PAC y est permise)', () => {
    const outcome = evaluatePreconditioning(
      entree({ energy: energie({ couleurJour: 'rouge', periode: 'HC' }) }),
    );
    expect(outcome?.setpoint).toBe(18);
  });

  it('jamais en cumul avec la préchauffe Tempo', () => {
    for (const couleurJour of ['bleu', 'rouge'] as const) {
      const outcome = evaluatePreconditioning(
        entree({
          energy: energie({ couleurJour, couleurDemain: 'rouge', periode: 'HC', preheatDelta: 1 }),
          // La consigne porte déjà le delta Tempo.
          baseSetpoint: 18,
        }),
      );
      expect(outcome?.setpoint).toBeUndefined();
      expect(outcome?.refusal).toBe('prechauffe_tempo');
      expect(outcome?.cause).toContain('pas de cumul de deltas');
      expect(outcome?.cause).toContain('+1.0 °C');
    }
  });

  it('jamais pendant un délestage, et le délestage passe avant tout le reste', () => {
    const outcome = evaluatePreconditioning(entree({ shedding: true }));
    expect(outcome?.setpoint).toBeUndefined();
    expect(outcome?.refusal).toBe('delestage');
    // Même un jour rouge HP : c'est le délestage qui est cité, il prime.
    expect(
      evaluatePreconditioning(
        entree({ shedding: true, energy: energie({ couleurJour: 'rouge', periode: 'HP' }) }),
      )?.refusal,
    ).toBe('delestage');
  });
});

// ─────────────────────── la règle, branchée dans `decide` ───────────────────────

const config: RegulationConfig = parseRegulationConfig({
  rooms: {
    salon: {
      sensors: ['temp_salon'],
      actuators: { pac: 'clim_salon' },
      setpoints: SETPOINTS,
    },
  },
  hysteresis: 0.4,
  night: { start: '22:30', end: '06:30' },
  presence_timeout_min: 30,
  energy: {
    tempo_rouge: { hp: { pac: 'forbidden' }, hc: { pac: 'allowed' } },
    preheat_before_red: { start: '02:00', delta: 1 },
  },
  delestage: { max_va: 9000, margin_va: 1000, rearm_va: 7000, shed_order: ['clim_salon'] },
  anti_short_cycle_min: 5,
  preconditioning: { enabled: true, lookahead_min: 45, threshold: 0.6, max_delta: 1 },
});

interface MondeOptions {
  now?: number;
  celsius?: number;
  couleurJour?: 'bleu' | 'blanc' | 'rouge';
  couleurDemain?: 'bleu' | 'blanc' | 'rouge' | 'inconnue';
  periode?: 'HP' | 'HC';
  va?: number;
  profile?: OccupancyProfile;
}

/** Salon vide depuis trois heures, PAC à l'arrêt, monde par ailleurs paisible. */
function monde(options: MondeOptions = {}): Snapshot {
  const now = options.now ?? JEUDI_17H45;
  return {
    rooms: [
      {
        room: 'salon',
        sensors: [{ entityId: 'temp_salon', value: options.celsius ?? 17.2, stale: false }],
        presence: [
          { entityId: 'presence_salon', value: false, ts: now - 3 * 3_600_000, stale: false },
        ],
        pac: {
          entityId: 'clim_salon',
          role: 'pac',
          known: true,
          stale: false,
          driverOnline: true,
          power: false,
          mode: 'heat',
          targetTemp: 17,
        },
      },
    ],
    tempo: {
      entityId: 'tempo_jour',
      couleurJour: options.couleurJour ?? 'bleu',
      couleurDemain: options.couleurDemain ?? 'bleu',
      periode: options.periode ?? 'HP',
      stale: false,
    },
    power: { entityId: 'power_maison', va: options.va ?? 1000, stale: false },
    shed: [],
    alerts: [],
    lastPowerChangeAt: {},
    ...(options.profile !== undefined ? { occupancy: options.profile } : {}),
  };
}

describe('préconditionnement — vu depuis `decide`', () => {
  it('sans profil, rien ne change (la régulation reste celle de la P6)', () => {
    const outcome = decide(monde(), config, JEUDI_17H45);
    expect(outcome.rooms[0]?.setpoint).toBe(17);
    expect(outcome.rooms[0]?.precondition).toBeUndefined();
    expect(outcome.decisions).toEqual([]);
  });

  it('avec profil, la consigne monte à 18 °C et la PAC démarre en le disant', () => {
    const outcome = decide(monde({ profile: PROFIL }), config, JEUDI_17H45);
    const salon = outcome.rooms[0];

    expect(salon?.setpoint).toBe(18);
    expect(salon?.precondition?.horizon).toBe('18:30');
    // 17.2 °C < 18 − 0.4 : la bande morte déclenche, ce qu'elle ne faisait pas à 17.
    const marche = outcome.decisions.find((decision) => decision.decision === 'pac_marche');
    expect(marche?.severity).toBe('action');
    expect(marche?.command?.params).toEqual({ power: true, mode: 'heat', targetTemp: 18 });
    expect(marche?.cause).toContain('préconditionnement');
    expect(marche?.cause).toContain('occupation probable à 18:30');
  });

  it('jour rouge en heures pleines : consigne inchangée, refus tracé', () => {
    const outcome = decide(
      monde({ profile: PROFIL, couleurJour: 'rouge', couleurDemain: 'inconnue' }),
      config,
      JEUDI_17H45,
    );
    const salon = outcome.rooms[0];

    expect(salon?.setpoint).toBe(17);
    expect(salon?.precondition).toBeUndefined();
    const refus = outcome.decisions.find(
      (decision) => decision.decision === 'preconditionnement_refuse',
    );
    expect(refus?.severity).toBe('blocked');
    expect(refus?.cause).toContain('jour rouge en heures pleines');
    // Et surtout : aucune commande de chauffe n'est partie.
    expect(outcome.decisions.filter((decision) => decision.command !== undefined)).toEqual([]);
  });

  it('délestage en cours : la coupure passe, la préchauffe non', () => {
    // 9400 VA > 9000 − 1000 : `decide` coupe la PAC dans le même tour.
    const outcome = decide(monde({ profile: PROFIL, va: 9400 }), config, JEUDI_17H45);

    expect(outcome.shed).toEqual(['clim_salon']);
    expect(outcome.rooms[0]?.setpoint).toBe(17);
    expect(
      outcome.decisions.find((decision) => decision.decision === 'preconditionnement_refuse')
        ?.cause,
    ).toContain('délestage en cours');
  });

  it('pièce occupée : la règle s’efface devant le fait', () => {
    const snapshot = monde({ profile: PROFIL });
    const salon = snapshot.rooms[0];
    if (salon)
      salon.presence = [{ entityId: 'presence_salon', value: true, ts: JEUDI_17H45, stale: false }];

    const outcome = decide(snapshot, config, JEUDI_17H45);
    expect(outcome.rooms[0]?.mode).toBe('present');
    expect(outcome.rooms[0]?.setpoint).toBe(20.5);
    expect(outcome.rooms[0]?.precondition).toBeUndefined();
  });
});
