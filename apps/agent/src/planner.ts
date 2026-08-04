import { z } from 'zod';
import { Kind, valueOf, type Entity, type TempoValue } from '@stellar/contracts';
import type { CoreMcpClient, RegulationSnapshot } from './core-mcp.js';
import type { AgentRuntime, AgentTurnResult } from './session.js';

/**
 * Planner du matin (spec §11) — un tour d'agent déclenché à 7 h par un timer systemd.
 *
 * Le prompt est **pré-rempli** avec ce que la maison sait déjà (couleur du jour,
 * météo, consignes en vigueur). Deux raisons : l'annonce du réveil doit partir vite
 * (pas trois allers-retours d'outils avant la première phrase), et un brief dont le
 * contexte est construit par du code est reproductible — on peut le tester sans
 * modèle. L'agent garde ses outils pour creuser si un point lui manque.
 */

/** Les `kind` par leur enum, jamais en littéral (règle n°7, mécanisée par ESLint). */
const TEMPO_KIND = Kind.enum.tempo;
const WEATHER_KIND = Kind.enum.weather;
const TEMPERATURE_KIND = Kind.enum.temperature;

/** Au-delà, l'énumération n'apporte plus rien au prompt. */
const MAX_PERCEPTS = 8;

/**
 * Vue minimale des paramètres de régulation. Volontairement **découplée** du schéma
 * du core : l'agent n'a pas à casser quand une clé de régulation est ajoutée, et
 * `apps/agent` ne dépend pas d'`apps/core` en production.
 */
const RegulationView = z
  .object({
    rooms: z.record(
      z
        .object({ setpoints: z.record(z.number()).optional() })
        .passthrough()
        .optional(),
    ),
  })
  .passthrough();

export interface MorningContext {
  now: Date;
  tempo?: TempoValue;
  /** Percepts météo et températures, pour éviter un aller-retour d'outil. */
  percepts: Entity[];
  regulation?: RegulationSnapshot;
}

export async function collectMorningContext(
  client: CoreMcpClient,
  now: Date,
): Promise<MorningContext> {
  const [tempoStates, weather, temperatures, regulation] = await Promise.all([
    client.getStates({ kind: TEMPO_KIND }),
    client.getStates({ kind: WEATHER_KIND }),
    client.getStates({ kind: TEMPERATURE_KIND }),
    client.getRegulationConfig(),
  ]);

  const tempoEntity = [...tempoStates].sort((a, b) => a.id.localeCompare(b.id))[0];
  const tempo = tempoEntity === undefined ? undefined : valueOf(tempoEntity, TEMPO_KIND);

  return {
    now,
    ...(tempo !== undefined ? { tempo } : {}),
    percepts: [...weather, ...temperatures].slice(0, MAX_PERCEPTS),
    ...(regulation !== undefined ? { regulation } : {}),
  };
}

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  dateStyle: 'full',
  timeStyle: 'short',
});

/** Le `value` d'une entité est un `unknown` par contrat : jamais de stringification implicite. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'indisponible');
}

function describePercept(entity: Entity): string {
  const where = entity.room === undefined ? '' : ` (${entity.room})`;
  const unit = entity.unit === undefined ? '' : ` ${entity.unit}`;
  const stale = entity.stale === true ? ' [donnée périmée]' : '';
  return `${entity.id}${where} : ${formatValue(entity.value)}${unit}${stale}`;
}

function describeSetpoints(regulation: RegulationSnapshot | undefined): string[] {
  if (regulation === undefined) return ['consignes indisponibles'];
  const parsed = RegulationView.safeParse(regulation.config);
  if (!parsed.success) return ['consignes illisibles'];
  const lines = Object.entries(parsed.data.rooms).map(([room, settings]) => {
    const setpoints = settings?.setpoints;
    if (setpoints === undefined) return `${room} : aucune consigne`;
    const detail = Object.entries(setpoints)
      .map(([mode, celsius]) => `${mode} ${celsius} °C`)
      .join(', ');
    return `${room} : ${detail}`;
  });
  return lines.length === 0 ? ['aucune pièce configurée'] : lines;
}

/**
 * Contexte injecté dans le prompt système : ce tour n'est pas une réponse, c'est
 * une prise de parole. Sans ça, l'agent répondrait comme si on l'avait interrogé.
 */
export const PLANNER_CONTEXT =
  'Ce tour est déclenché automatiquement au réveil, personne ne t’a parlé. Tu ouvres le dialogue par une annonce courte.';

export function buildMorningPrompt(context: MorningContext): string {
  const tarif =
    context.tempo === undefined
      ? 'Tarif Tempo : information indisponible.'
      : `Tarif Tempo : aujourd’hui ${context.tempo.couleurJour}, demain ${context.tempo.couleurDemain}, période en cours ${context.tempo.periode}.`;

  const percepts =
    context.percepts.length === 0
      ? ['aucun percept disponible']
      : context.percepts.map(describePercept);

  return [
    `Brief du matin — ${dateFormatter.format(context.now)}.`,
    '',
    'Relevé de la maison (déjà lu pour toi, ne le redemande pas) :',
    `- ${tarif}`,
    `- Percepts : ${percepts.join(' ; ')}.`,
    `- Consignes de chauffage en vigueur : ${describeSetpoints(context.regulation).join(' ; ')}.`,
    '',
    'Prépare l’annonce du réveil. Complète avec tes outils seulement si un point te manque vraiment (état de la maison, journal de la nuit, météo du jour sur le web).',
    'Dis en trois phrases maximum : ce que la couleur du jour implique concrètement, le temps qu’il fera, et le seul point qui mérite une attention aujourd’hui.',
    'Termine par une question courte.',
  ].join('\n');
}

export interface PlannerDeps {
  client: CoreMcpClient;
  runtime: AgentRuntime;
  now?: Date;
}

export async function morningBrief(deps: PlannerDeps): Promise<AgentTurnResult> {
  const context = await collectMorningContext(deps.client, deps.now ?? new Date());
  return deps.runtime.runTurn({
    prompt: buildMorningPrompt(context),
    context: PLANNER_CONTEXT,
  });
}
