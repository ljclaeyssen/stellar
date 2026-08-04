import { readFileSync } from 'node:fs';

/**
 * L'état du simulateur, c'est un **calendrier de couleurs** — pas un payload.
 *
 * Contrairement à sim-netatmo (dont l'état EST le corps de réponse), les deux
 * APIs Tempo servent la même information sous deux formes très différentes :
 * on stocke donc l'information, et les fixtures ne servent que de **gabarits**
 * de forme (enveloppe, noms de champs, format des dates). Recaler une fixture
 * recale la forme servie par le simulateur sans toucher au code.
 */
export type SimCouleur = 'bleu' | 'blanc' | 'rouge';

export type Json = Record<string, unknown>;

export interface SimTempoState {
  /** Couleur connue par clé de jour Tempo (`YYYY-MM-DD`). Absente = inconnue. */
  colors: Record<string, SimCouleur>;
  /** `POST /token/oauth/` et `GET …/tempo_like_calendars` répondent 503. */
  rteDown: boolean;
  /** `GET /api/jourTempo/…` répond 503. */
  fallbackDown: boolean;
  /** Access token courant délivré par `/token/oauth/`. */
  accessToken: string;
  /** Compteurs d'appels — assertions de test (« le driver n'a PAS appelé RTE »). */
  tokenCalls: number;
  rteCalendarCalls: number;
  fallbackCalls: number;
}

/** `codeJour` de api-couleur-tempo.fr : 0 = inconnu. */
export const CODE_BY_COULEUR: Record<SimCouleur, number> = { bleu: 1, blanc: 2, rouge: 3 };

/** Valeurs de l'API RTE. */
export const RTE_BY_COULEUR: Record<SimCouleur, string> = {
  bleu: 'BLUE',
  blanc: 'WHITE',
  rouge: 'RED',
};

const FIXTURES = new URL('../../../drivers/tempo/__fixtures__/', import.meta.url);

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFixture(file: string): Json {
  const url = new URL(file, FIXTURES);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    throw new Error(
      `fixture Tempo illisible (${url.pathname}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(raw)) throw new Error(`fixture Tempo inattendue (objet attendu) : ${url.pathname}`);
  return raw;
}

export interface Templates {
  /** `POST /token/oauth/` — seul `access_token` est réécrit. */
  token: Json;
  /** Une entrée de `tempo_like_calendars.values` : gabarit d'un jour. */
  rteValue: Json;
  /** Enveloppe de `tempo_like_calendars`, `values` exclues. */
  rteEnvelope: Json;
  /** `GET /api/jourTempo/<date>` — `dateJour`/`codeJour` sont réécrits. */
  jourTempo: Json;
}

/**
 * Gabarits extraits des fixtures du driver. Une fixture recalée sur le réel
 * (champ ajouté, renommé) se propage donc au simulateur sans code : seuls
 * `start_date`, `end_date`, `value`, `dateJour`, `codeJour` et `access_token`
 * sont substitués, tout le reste est repris tel quel.
 */
export function loadTemplates(): Templates {
  const token = readFixture('rte/oauth-response.json');
  const calendars = readFixture('rte/tempo_like_calendars.json');
  const jourTempo = readFixture('opendata/jour-tempo.json');

  const inner = calendars['tempo_like_calendars'];
  if (!isRecord(inner)) {
    throw new Error(
      'fixture rte/tempo_like_calendars.json : clé « tempo_like_calendars » attendue',
    );
  }
  const values = inner['values'];
  const first = (Array.isArray(values) ? values.filter(isRecord) : [])[0];
  if (first === undefined) {
    throw new Error(
      'fixture rte/tempo_like_calendars.json : une entrée « values » au moins attendue',
    );
  }
  const envelope: Json = { ...inner };
  delete envelope['values'];

  return { token, rteValue: first, rteEnvelope: envelope, jourTempo };
}
