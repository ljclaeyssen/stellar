import type { Logger } from '@stellar/bus';
import type { TempoColors, TempoSourceLike } from './tempo.js';

export interface TempoReadResult {
  colors: TempoColors;
  /** Nom de la source qui a répondu — loggé et exposé pour l'observabilité. */
  source: string;
}

export interface TempoReader {
  /**
   * Couleurs des jours demandés. Le **premier** jour de la liste est le jour
   * Tempo courant : sans lui, rien n'est publiable, donc rien n'est retourné.
   */
  read(dayKeys: readonly string[]): Promise<TempoReadResult>;
}

export interface TempoReaderOptions {
  /** Source primaire (RTE). Absente quand aucun identifiant n'est configuré. */
  primary?: TempoSourceLike;
  fallback: TempoSourceLike;
  logger: Logger;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Politique de source (spec §9) : RTE d'abord **si** on a des identifiants,
 * l'opendata public sinon — ou en repli quand RTE flanche.
 *
 * Deux cas comptent pour un échec de source, et c'est délibéré :
 *
 * - la requête échoue (réseau, HTTP, contrat) ;
 * - la requête réussit mais ne contient pas la couleur du **jour courant**. Une
 *   réponse vide n'est pas une réponse : sans couleur du jour, `TempoValue` est
 *   inconstructible (le contrat n'admet « inconnue » que pour demain). Autant
 *   demander au fallback, qui a peut-être l'information.
 *
 * Le driver n'a donc à connaître qu'une chose : « j'ai des couleurs » ou « ce
 * cycle a échoué ».
 */
export function createTempoReader(options: TempoReaderOptions): TempoReader {
  const { primary, fallback, logger } = options;
  const sources: TempoSourceLike[] = primary === undefined ? [fallback] : [primary, fallback];

  return {
    async read(dayKeys) {
      const today = dayKeys[0];
      if (today === undefined) throw new Error('aucun jour demandé');

      let lastError: unknown;
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        if (source === undefined) continue;
        try {
          const colors = await source.fetchColors(dayKeys);
          if (colors[today] !== undefined) {
            if (index > 0)
              logger.info('couleur Tempo obtenue du fallback', { source: source.name });
            return { colors, source: source.name };
          }
          lastError = new Error(`source ${source.name} sans couleur pour le jour Tempo ${today}`);
        } catch (err) {
          lastError = err;
        }
        const next = sources[index + 1];
        if (next !== undefined) {
          logger.warn('source Tempo en échec, bascule sur la suivante', {
            source: source.name,
            next: next.name,
            error: describe(lastError),
          });
        }
      }
      throw new Error(
        `aucune source Tempo exploitable pour ${today} — ${describe(lastError ?? 'cause inconnue')}`,
      );
    },
  };
}
