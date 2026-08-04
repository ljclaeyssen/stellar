import { probabilityAt, type OccupancyProfile } from '../predictive/occupancy.js';
import type { PreconditioningConfig, Setpoints } from './regulation-config.js';
import { localTime } from './time.js';
import type { EnergyEvaluation, OccupancyMode } from './types.js';

/**
 * PRÉCONDITIONNEMENT PRÉDICTIF (P9, spec §16) — **fonction pure**.
 *
 * La règle tient en une phrase : *une pièce vide dont le profil d'occupation dit
 * qu'elle sera occupée dans trois quarts d'heure se chauffe un peu à l'avance,
 * sauf si l'énergie coûte cher*.
 *
 * Elle est déterministe et calculée dans le core (principe n°1 : aucun LLM dans
 * une boucle de régulation). Elle ne fait qu'**une seule chose** : relever la
 * consigne d'une pièce en mode `absent`. Elle n'allume rien, ne réarme rien, ne
 * choisit aucun actionneur — c'est l'hystérésis et la politique énergie déjà en
 * place qui décident de la suite.
 *
 * ## Les trois interdits (DoD P9 : « sans hausse de conso les jours rouges »)
 *
 * 1. **Délestage en cours** → jamais. Le disjoncteur passe avant le confort ;
 *    monter une consigne pendant qu'on coupe des PAC serait absurde.
 * 2. **Jour rouge en heures pleines** → jamais. C'est le kWh à 4–5× le tarif
 *    normal, et c'est exactement la dépense que le DoD interdit.
 * 3. **Préchauffe Tempo déjà active** → jamais. Les deux règles poussent la même
 *    consigne pour deux bonnes raisons ; les cumuler donnerait un delta que
 *    personne n'a arbitré. La préchauffe Tempo, plus ancienne et plus large
 *    (toute la maison, avant un jour rouge), garde la main.
 *
 * Ces trois cas produisent une décision **`blocked`** : elle n'atteint pas le bus
 * (pas d'inondation du journal, cf. `DecisionSeverity`) mais elle est tracée en
 * debug et **visible dans les goldens** — le refus doit être aussi lisible que
 * l'action.
 */

export interface PreconditioningInput {
  room: string;
  /** Mode courant : la règle ne s'applique qu'en `absent`. */
  mode: OccupancyMode;
  /** Aucune mesure exploitable : on ne préchauffe pas à l'aveugle. */
  degraded: boolean;
  setpoints: Setpoints;
  /** Consigne déjà calculée (mode + préchauffe Tempo). */
  baseSetpoint: number;
  energy: EnergyEvaluation;
  profile: OccupancyProfile | undefined;
  config: PreconditioningConfig;
  timezone: string;
  now: number;
  /** Un délestage est en cours quelque part dans la maison. */
  shedding: boolean;
}

export interface PreconditioningOutcome {
  /** Consigne relevée. Absente quand la préchauffe est refusée. */
  setpoint?: number;
  /** Probabilité d'occupation à l'horizon (déjà au-dessus du seuil). */
  probability: number;
  /** Heure locale de l'horizon, `HH:MM`. */
  horizon: string;
  /** Phrase lisible : ce qui a été fait, ou ce qui a été refusé et pourquoi. */
  cause: string;
  /** Présent uniquement en cas de refus (identifiant court, pour les tests). */
  refusal?: 'delestage' | 'rouge_hp' | 'prechauffe_tempo';
}

const MINUTE = 60_000;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const t = (value: number): string => value.toFixed(1);

/**
 * `undefined` = la règle ne s'applique pas (pièce occupée, profil muet,
 * probabilité sous le seuil…) : rien à dire, rien à tracer.
 *
 * Un objet **avec** `setpoint` = préchauffe douce à appliquer.
 * Un objet **sans** `setpoint` = préchauffe justifiée mais refusée (`refusal`).
 */
export function evaluatePreconditioning(
  input: PreconditioningInput,
): PreconditioningOutcome | undefined {
  const { config, profile } = input;
  if (!config.enabled || !profile) return undefined;
  // Seule une pièce déclarée vide se préconditionne : `nuit` a sa propre consigne,
  // `present` n'a rien à anticiper, `hors_gel` veut dire qu'on ne mesure plus rien.
  if (input.degraded || input.mode !== 'absent') return undefined;

  const horizonMs = input.now + config.lookahead_min * MINUTE;
  const probability = probabilityAt(profile, input.room, horizonMs);
  if (probability === undefined || probability < config.threshold) return undefined;

  const local = localTime(horizonMs, input.timezone);
  const horizon = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const observed = `occupation probable à ${horizon} (p=${probability.toFixed(2)})`;

  const refuse = (
    refusal: NonNullable<PreconditioningOutcome['refusal']>,
    why: string,
  ): PreconditioningOutcome => ({
    probability,
    horizon,
    refusal,
    cause: `${observed}, mais préconditionnement refusé : ${why}`,
  });

  if (input.shedding) {
    return refuse('delestage', 'délestage en cours (le disjoncteur passe avant le confort)');
  }
  if (input.energy.couleurJour === 'rouge' && input.energy.periode === 'HP') {
    return refuse('rouge_hp', 'jour rouge en heures pleines — aucune hausse de consigne');
  }
  if (input.energy.preheatDelta > 0) {
    return refuse(
      'prechauffe_tempo',
      `préchauffe Tempo déjà active (+${t(input.energy.preheatDelta)} °C), pas de cumul de deltas`,
    );
  }

  // Douce par construction : on vise la consigne « présent », plafonnée à
  // `absent + max_delta`. Sur le salon livré (17 → 20,5, delta 1) : 18 °C.
  const target = round1(
    Math.min(input.setpoints.present, input.setpoints.absent + config.max_delta),
  );
  // Une consigne « absent » déjà au-dessus de la cible (ou un delta nul) : rien à
  // faire, et surtout rien à dire — ce n'est ni une action ni un refus.
  if (target <= input.baseSetpoint) return undefined;

  return {
    setpoint: target,
    probability,
    horizon,
    cause: `préconditionnement : ${observed} → consigne ${t(target)} °C au lieu de ${t(input.baseSetpoint)} °C`,
  };
}
