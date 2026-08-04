import { z } from 'zod';
import type { TempoValue } from '@stellar/contracts';

/**
 * Les trois couleurs du contrat. Dérivée de `TempoValue` plutôt que redéclarée :
 * `couleurJour` ne connaît pas « inconnue », `couleurDemain` si — la distinction
 * est portée par le contrat, pas par le driver.
 */
export type TempoCouleur = TempoValue['couleurJour'];

/**
 * Payloads bruts des deux sources Tempo, validés à la frontière de process
 * (règle spec n°4). Rien ici ne décide : ce module ne fait que dire « voilà ce
 * que l'API a le droit de m'envoyer » et traduire ses codes en couleurs du
 * contrat.
 */

/** `POST /token/oauth/` — OAuth2 client credentials du portail RTE. */
export const RteTokenResponse = z.object({
  access_token: z.string().min(1),
  /** Secondes. RTE annonce 7200 ; on se garde d'un absent (défaut prudent). */
  expires_in: z.number().positive().optional(),
  token_type: z.string().optional(),
});
export type RteTokenResponse = z.infer<typeof RteTokenResponse>;

/** Une période du calendrier RTE — un jour Tempo, de 6 h à 6 h. */
export const RteCalendarValue = z.object({
  start_date: z.string().min(1),
  end_date: z.string().optional(),
  value: z.string(),
  updated_date: z.string().optional(),
});
export type RteCalendarValue = z.infer<typeof RteCalendarValue>;

/**
 * L'enveloppe est validée sans typer les entrées : une période bizarre ne doit
 * pas faire disparaître tout le calendrier (elle sera loggée et jetée une par
 * une, comme les ressources Netatmo).
 */
export const RteCalendarsResponse = z.object({
  tempo_like_calendars: z.object({
    values: z.array(z.unknown()),
  }),
});
export type RteCalendarsResponse = z.infer<typeof RteCalendarsResponse>;

/** `GET /api/jourTempo/<yyyy-mm-dd>` — api-couleur-tempo.fr. */
export const JourTempoResponse = z.object({
  dateJour: z.string().min(1),
  /** 0 = inconnu (non publié), 1 = bleu, 2 = blanc, 3 = rouge. */
  codeJour: z.number().int().min(0).max(3),
  periodeUpdate: z.string().optional(),
});
export type JourTempoResponse = z.infer<typeof JourTempoResponse>;

/** Couleurs de l'API RTE. */
const RTE_COLORS: Record<string, TempoCouleur> = {
  BLUE: 'bleu',
  WHITE: 'blanc',
  RED: 'rouge',
};

/** `codeJour` de l'opendata. 0 (inconnu) n'a délibérément pas d'entrée. */
const OPENDATA_COLORS: Record<number, TempoCouleur> = {
  1: 'bleu',
  2: 'blanc',
  3: 'rouge',
};

/** `undefined` si la valeur n'est pas une couleur connue — à logger et jeter. */
export function couleurFromRte(value: string): TempoCouleur | undefined {
  return RTE_COLORS[value.trim().toUpperCase()];
}

/** `undefined` pour `codeJour: 0` (jour non encore publié) comme pour l'inattendu. */
export function couleurFromCodeJour(code: number): TempoCouleur | undefined {
  return OPENDATA_COLORS[code];
}

/** Couleur connue par clé de jour Tempo (`YYYY-MM-DD`). */
export type TempoColors = Readonly<Record<string, TempoCouleur>>;

/**
 * Couture du driver avec une source de couleurs (ADR-010 niveau 1) : RTE et
 * l'opendata n'ont en commun ni l'authentification, ni le nombre de requêtes,
 * ni la forme des réponses — seulement ce contrat.
 */
export interface TempoSourceLike {
  /** `rte` ou `opendata` — sert aux logs de bascule et aux dumps `verify`. */
  readonly name: string;
  /**
   * Couleurs connues pour ces jours Tempo. Un jour absent du résultat = pas
   * encore publié : ce n'est **pas** une erreur (le lendemain avant 11 h).
   */
  fetchColors(dayKeys: readonly string[]): Promise<TempoColors>;
}
