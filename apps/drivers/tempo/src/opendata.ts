import { fetch as undiciFetch } from 'undici';
import type { Logger } from '@stellar/bus';
import {
  JourTempoResponse,
  couleurFromCodeJour,
  type TempoCouleur,
  type TempoSourceLike,
} from './tempo.js';

export const JOUR_TEMPO_PATH = '/api/jourTempo';

export interface OpendataSourceOptions {
  /** `https://www.api-couleur-tempo.fr` en prod, le simulateur en test. */
  baseUrl: string;
  logger: Logger;
  requestTimeoutMs?: number;
}

/**
 * Source de repli : l'API publique api-couleur-tempo.fr — **sans compte, sans
 * authentification**. C'est elle qui rend le driver utilisable dès le premier
 * jour, avant même que l'humain ait créé son application sur data.rte-france.com
 * (TODO_LJ.md §P6).
 *
 * Une requête par jour (l'API n'expose qu'un jour à la fois) : deux appels par
 * cycle, une fois par heure. Négligeable pour un service public gratuit.
 */
export function createOpendataSource(options: OpendataSourceOptions): TempoSourceLike {
  const { logger } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const fetchDay = async (dayKey: string): Promise<TempoCouleur | undefined> => {
    const url = `${baseUrl}${JOUR_TEMPO_PATH}/${encodeURIComponent(dayKey)}`;
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `GET ${JOUR_TEMPO_PATH}/${dayKey} → HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`GET ${JOUR_TEMPO_PATH}/${dayKey} → réponse non JSON`);
    }
    const parsed = JourTempoResponse.safeParse(json);
    if (!parsed.success) throw new Error(`réponse ${JOUR_TEMPO_PATH}/${dayKey} hors contrat`);
    if (parsed.data.dateJour.slice(0, 10) !== dayKey) {
      // L'API a répondu pour un autre jour : mieux vaut ne rien publier que
      // publier la couleur d'hier comme celle d'aujourd'hui.
      throw new Error(
        `réponse ${JOUR_TEMPO_PATH}/${dayKey} pour un autre jour: ${parsed.data.dateJour}`,
      );
    }
    // `codeJour: 0` = jour non publié : absence de couleur, pas une erreur.
    return couleurFromCodeJour(parsed.data.codeJour);
  };

  return {
    name: 'opendata',

    async fetchColors(dayKeys) {
      const settled = await Promise.allSettled(dayKeys.map((dayKey) => fetchDay(dayKey)));
      const colors: Record<string, TempoCouleur> = {};
      const failures: string[] = [];

      settled.forEach((result, index) => {
        const dayKey = dayKeys[index] ?? '';
        if (result.status === 'rejected') {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          failures.push(`${dayKey}: ${reason}`);
          return;
        }
        if (result.value !== undefined) colors[dayKey] = result.value;
      });

      // Un jour en échec sur deux n'est pas rédhibitoire (le lendemain peut
      // manquer sans conséquence) ; tout en échec, si : on remonte l'erreur pour
      // que le driver compte un cycle raté plutôt que d'inventer un état.
      if (failures.length > 0 && failures.length === dayKeys.length) {
        throw new Error(`source opendata injoignable — ${failures.join(' ; ')}`);
      }
      if (failures.length > 0) logger.warn('jour opendata illisible, ignoré', { failures });
      return colors;
    },
  };
}
