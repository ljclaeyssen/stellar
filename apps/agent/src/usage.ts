import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Budget de l'agent (spec §11 : « budget tokens **et** recherches loggé par jour »).
 *
 * Le cumul est un fichier par jour plutôt qu'une ligne dans SQLite : il doit
 * survivre à un core éteint, se lire à l'œil nu, et se purger d'un `rm`. Le coût
 * de l'API Claude est le seul coût récurrent du projet (spec §1) — il mérite une
 * trace qu'on peut consulter sans outil.
 */

/** Ce qu'un tour a consommé. Les tokens sont absents si le SDK ne les expose pas. */
export interface TurnUsage {
  durationMs: number;
  /** Appels d'outils émis par le modèle pendant le tour. */
  toolCalls: number;
  /** Aller-retours modèle du tour (`num_turns` du SDK). */
  modelTurns: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

/** Cumul d'une journée, tel qu'écrit sur disque. */
export const DailyUsage = z.object({
  date: z.string(),
  turns: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokensIn: z.number().nonnegative(),
  tokensOut: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  updatedAt: z.string(),
});
export type DailyUsage = z.infer<typeof DailyUsage>;

/** `yyyy-mm-dd` en heure **UTC** — même convention que les `ts` du bus (spec §6). */
export function usageDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function usageFilePath(dir: string, now: Date): string {
  return join(dir, `agent-usage-${usageDate(now)}.json`);
}

function emptyDaily(date: string, now: Date): DailyUsage {
  return {
    date,
    turns: 0,
    errors: 0,
    durationMs: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    updatedAt: now.toISOString(),
  };
}

/**
 * Lit le cumul du jour. Un fichier absent, illisible ou hors contrat repart de
 * zéro : perdre une statistique est sans gravité, refuser de servir un tour de
 * conversation parce qu'un fichier de compteurs est corrompu ne l'est pas.
 */
export function readDailyUsage(dir: string, now: Date): DailyUsage {
  const date = usageDate(now);
  try {
    const parsed = DailyUsage.safeParse(JSON.parse(readFileSync(usageFilePath(dir, now), 'utf8')));
    if (parsed.success && parsed.data.date === date) return parsed.data;
  } catch {
    // fichier absent ou illisible → cumul neuf
  }
  return emptyDaily(date, now);
}

export interface RecordUsageOptions {
  dir: string;
  usage: TurnUsage;
  /** Le tour s'est-il terminé en erreur (timeout, échec SDK) ? */
  isError: boolean;
  now: Date;
}

/**
 * Ajoute un tour au cumul du jour et le persiste. Écriture temporaire puis
 * `rename` : un arrêt brutal au mauvais moment ne laisse pas un JSON tronqué.
 */
export function recordUsage(options: RecordUsageOptions): DailyUsage {
  const { dir, usage, isError, now } = options;
  const current = readDailyUsage(dir, now);
  const next: DailyUsage = {
    ...current,
    turns: current.turns + 1,
    errors: current.errors + (isError ? 1 : 0),
    durationMs: current.durationMs + usage.durationMs,
    toolCalls: current.toolCalls + usage.toolCalls,
    tokensIn: current.tokensIn + (usage.tokensIn ?? 0),
    tokensOut: current.tokensOut + (usage.tokensOut ?? 0),
    cacheReadTokens: current.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheCreationTokens: current.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
    costUsd: current.costUsd + (usage.costUsd ?? 0),
    updatedAt: now.toISOString(),
  };

  const path = usageFilePath(dir, now);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return next;
}
