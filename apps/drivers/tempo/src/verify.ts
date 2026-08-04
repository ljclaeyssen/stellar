import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@stellar/bus';
import type { TempoValue } from '@stellar/contracts';
import type { TempoCouleur, TempoSourceLike } from './tempo.js';
import { addDays, periodeAt, tempoDayKey, type Clock } from './time.js';

export interface VerifyOptions {
  /** Source RTE — absente quand aucun identifiant n'est configuré. */
  rte?: TempoSourceLike;
  fallback: TempoSourceLike;
  rteApiUrl: string;
  fallbackUrl: string;
  /** Dossier des fixtures du driver — le dump y atterrit daté. */
  fixturesDir: string;
  logger: Logger;
  clock?: Clock;
}

export interface VerifySourceReport {
  name: string;
  url: string;
  ok: boolean;
  colors?: Record<string, TempoCouleur>;
  error?: string;
}

export interface VerifySummary {
  dumpFile: string;
  /** Jours Tempo interrogés : le courant et le suivant. */
  days: [string, string];
  sources: VerifySourceReport[];
  /** Ce que le driver publierait, `null` si aucune source n'a la couleur du jour. */
  value: TempoValue | null;
}

/**
 * Étape 3 de la checklist de branchement matériel (docs/TESTING.md §3) :
 * **lecture seule**. On interroge les deux sources — RTE si des identifiants
 * existent, l'opendata dans tous les cas — on enregistre ce qu'elles répondent
 * en fixture datée, et on résume ce qui sortirait sur le bus. Sans toucher au
 * bus MQTT.
 *
 * Interroger les **deux** même quand RTE marche est le but : c'est la
 * comparaison des deux réponses qui valide la traduction des couleurs (`RED`
 * ↔ `codeJour: 3`) et le calage des jours Tempo.
 *
 * Le dump ne contient **aucun secret** (spec §14) : ni le client secret RTE, ni
 * l'access token — `verify` ne dumpe que les couleurs obtenues, jamais la
 * réponse `/token/oauth/`.
 */
export async function verify(options: VerifyOptions): Promise<VerifySummary> {
  const { rte, fallback, fixturesDir, logger } = options;
  const clock = options.clock ?? Date.now;

  const now = clock();
  const today = tempoDayKey(now);
  const days: [string, string] = [today, addDays(today, 1)];

  const probe = async (source: TempoSourceLike, url: string): Promise<VerifySourceReport> => {
    try {
      const colors = await source.fetchColors(days);
      return { name: source.name, url, ok: true, colors: { ...colors } };
    } catch (err) {
      return {
        name: source.name,
        url,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const sources: VerifySourceReport[] = [];
  if (rte !== undefined) sources.push(await probe(rte, options.rteApiUrl));
  else logger.info('aucun identifiant RTE configuré — seule la source de repli est vérifiée');
  sources.push(await probe(fallback, options.fallbackUrl));

  // Ce que publierait le driver : la première source qui connaît le jour gagne,
  // dans l'ordre de priorité — exactement la règle de `reader.ts`.
  const couleurJour = sources.find((report) => report.colors?.[days[0]] !== undefined)?.colors?.[
    days[0]
  ];
  const couleurDemain = sources.find((report) => report.colors?.[days[1]] !== undefined)?.colors?.[
    days[1]
  ];
  const value: TempoValue | null =
    couleurJour === undefined
      ? null
      : {
          couleurJour,
          couleurDemain: couleurDemain ?? 'inconnue',
          periode: periodeAt(now),
        };

  // `:` est interdit dans un nom de fichier Windows — l'ISO est aplati.
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(fixturesDir, `verify-${stamp}.json`);
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    dumpFile,
    `${JSON.stringify(
      {
        _note:
          'Capture des sources Tempo réelles (stellar-tempo verify, lecture seule). Comparer à __fixtures__/rte/ et __fixtures__/opendata/ puis recaler le simulateur en cas d’écart. Aucun secret n’est enregistré ici (ni client secret RTE, ni access token).',
        generatedAt: new Date(now).toISOString(),
        days,
        sources,
        value,
      },
      null,
      2,
    )}\n`,
  );

  const summary: VerifySummary = { dumpFile, days, sources, value };
  logger.info('verify terminé', {
    dumpFile,
    days,
    sources: sources.map((report) => `${report.name}: ${report.ok ? 'ok' : 'échec'}`),
    ...(value ?? {}),
  });
  return summary;
}
