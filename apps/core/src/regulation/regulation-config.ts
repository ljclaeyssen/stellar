import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Schéma de `config/regulation.yaml` (spec §10).
 *
 * Ce fichier est le **seul** que l'agent puisse modifier en production : sa
 * validation doit donc être stricte (`.strict()` partout — une clé inconnue est
 * une faute de frappe, pas une extension) et ses messages d'erreur lisibles par
 * un humain qui relit son fichier à 23 h.
 *
 * Les identifiants qu'il contient (`temp_salon`, `clim_salon`…) sont des
 * `entityId` du bus : de la **donnée de configuration**, jamais des noms de
 * drivers (spec règle n°7).
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TimeOfDay = z
  .string()
  .regex(HHMM, 'heure attendue au format HH:MM sur 24 h (heure locale), ex. 22:30');

const Setpoints = z
  .object({
    present: z.number(),
    absent: z.number(),
    nuit: z.number(),
    hors_gel: z.number(),
  })
  .strict();

const Actuators = z
  .object({
    /** Pompe à chaleur de la pièce (clim réversible) : pilotable marche/arrêt. */
    pac: z.string().min(1).optional(),
    /** Thermostat du chauffage central : on lui pousse une consigne, jamais un arrêt. */
    central: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (actuators) => actuators.pac !== undefined || actuators.central !== undefined,
    'une pièce doit déclarer au moins un actionneur (`pac` ou `central`)',
  );

const RoomConfig = z
  .object({
    /** Capteurs de température par ordre de préférence ; fallback = `pac.indoorTemp`. */
    sensors: z.array(z.string().min(1)).default([]),
    actuators: Actuators,
    setpoints: Setpoints,
  })
  .strict();

/** `forbidden` : la PAC ne doit pas chauffer ; `allowed` : elle est utilisable. */
const PacPolicy = z.enum(['forbidden', 'allowed']);

/**
 * Préconditionnement prédictif (P9, spec §16).
 *
 * `enabled: false` par défaut, et le défaut est **le bon** : la règle n'a de sens
 * qu'une fois qu'un profil d'occupation existe (quelques semaines de journal).
 * Tant qu'elle est éteinte, la régulation est exactement celle de la P6.
 */
const Preconditioning = z
  .object({
    enabled: z.boolean().default(false),
    /** Horizon d'anticipation, en minutes — l'inertie thermique du logement. */
    lookahead_min: z.number().positive().max(360).default(45),
    /** Probabilité d'occupation à l'horizon au-delà de laquelle on préchauffe. */
    threshold: z.number().min(0).max(1).default(0.6),
    /** Plafond de hausse au-dessus de la consigne « absent », en °C. */
    max_delta: z.number().min(0).max(5).default(1),
  })
  .strict();

const RegulationConfigSchema = z
  .object({
    rooms: z.record(RoomConfig),
    /** Demi-bande morte, en °C. */
    hysteresis: z.number().positive().max(5),
    night: z.object({ start: TimeOfDay, end: TimeOfDay }).strict(),
    presence_timeout_min: z.number().positive(),
    energy: z
      .object({
        tempo_rouge: z
          .object({
            hp: z.object({ pac: PacPolicy }).strict(),
            hc: z.object({ pac: PacPolicy }).strict(),
          })
          .strict(),
        preheat_before_red: z
          .object({ start: TimeOfDay, delta: z.number().min(0).max(5) })
          .strict(),
      })
      .strict(),
    delestage: z
      .object({
        max_va: z.number().positive(),
        margin_va: z.number().nonnegative(),
        rearm_va: z.number().nonnegative(),
        /** Ordre de sacrifice ; réarmement dans l'ordre inverse. */
        shed_order: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    anti_short_cycle_min: z.number().nonnegative(),
    /** Absent du fichier ⇒ éteint : un core sans profil régule comme en P6. */
    preconditioning: Preconditioning.default({}),
    /**
     * Absent du fichier livré : la maison est en région lilloise. La clé existe
     * pour que les tests (et un futur déménagement) n'aient pas à toucher au code.
     */
    timezone: z.string().min(1).default('Europe/Paris'),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (Object.keys(config.rooms).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rooms'],
        message: 'au moins une pièce est nécessaire',
      });
    }

    if (config.night.start === config.night.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['night'],
        message: 'la plage nuit est vide (start identique à end)',
      });
    }

    const { max_va, margin_va, rearm_va } = config.delestage;
    const shedThreshold = max_va - margin_va;
    if (shedThreshold <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delestage', 'margin_va'],
        message: `marge trop grande : le seuil de coupure vaut ${shedThreshold} VA`,
      });
    }
    // Sans cette marge, le réarmement rallumerait juste sous le seuil de coupure :
    // la charge repart, on recoupe — l'oscillation que la spec interdit.
    if (rearm_va >= shedThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delestage', 'rearm_va'],
        message: `le seuil de réarmement (${rearm_va} VA) doit rester sous le seuil de coupure (${shedThreshold} VA = max_va − margin_va)`,
      });
    }

    // Un préconditionnement actif à +0 °C n'aurait aucun effet : c'est forcément
    // une erreur de saisie (on voulait l'éteindre, ou on a oublié le delta).
    if (config.preconditioning.enabled && config.preconditioning.max_delta === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preconditioning', 'max_delta'],
        message:
          'un préconditionnement actif à +0 °C ne changerait rien : donner un delta, ou `enabled: false`',
      });
    }

    // Un `shed_order` qui cite une entité inconnue est une faute de frappe qui ne
    // se verrait qu'un jour de pic, à 9 kVA. On la refuse au chargement.
    const pacs = new Set<string>();
    for (const room of Object.values(config.rooms)) {
      if (room.actuators.pac !== undefined) pacs.add(room.actuators.pac);
    }
    config.delestage.shed_order.forEach((entityId, index) => {
      if (pacs.has(entityId)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delestage', 'shed_order', index],
        message: `« ${entityId} » n'est l'actionneur \`pac\` d'aucune pièce déclarée`,
      });
    });

    // Une pièce dont le capteur porte le nom de son actionneur (ou l'inverse) est
    // le genre d'erreur qui passe inaperçue jusqu'au premier hiver.
    for (const [name, room] of Object.entries(config.rooms)) {
      for (const sensor of room.sensors) {
        if (sensor !== room.actuators.pac && sensor !== room.actuators.central) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rooms', name, 'sensors'],
          message: `« ${sensor} » est déclaré à la fois comme capteur et comme actionneur`,
        });
      }
    }
  });

export type RegulationConfig = z.infer<typeof RegulationConfigSchema>;
export type RoomConfig = z.infer<typeof RoomConfig>;
export type Setpoints = z.infer<typeof Setpoints>;
export type PreconditioningConfig = z.infer<typeof Preconditioning>;

export { RegulationConfigSchema };

/** Message multi-lignes : un chemin + une raison par ligne. */
function formatIssues(error: z.ZodError, source: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(racine)';
    return `  - ${path} : ${issue.message}`;
  });
  return [`configuration de régulation invalide (${source}) :`, ...lines].join('\n');
}

/** Valide un objet déjà désérialisé (tests, futur `propose_regulation_change`). */
export function parseRegulationConfig(input: unknown, source = 'objet'): RegulationConfig {
  const parsed = RegulationConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(formatIssues(parsed.error, source));
  return parsed.data;
}

/** Valide le YAML brut (le format du fichier de production). */
export function parseRegulationYaml(text: string, source = 'yaml'): RegulationConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `YAML illisible (${source}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseRegulationConfig(raw, source);
}

/**
 * Charge et valide `config/regulation.yaml`. Toute erreur (fichier absent, YAML
 * cassé, clé inconnue) remonte avec le chemin du fichier — le core doit refuser
 * de démarrer plutôt que de réguler avec une configuration à moitié comprise.
 */
export function loadRegulationConfig(path: string): RegulationConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `configuration de régulation illisible (${path}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseRegulationYaml(text, path);
}
