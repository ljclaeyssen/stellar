/** Logs JSON structurés sur stdout — règle commune drivers (spec §9). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export const REDACTED = '[REDACTED]';

/**
 * Clés dont la valeur ne doit jamais atterrir dans un log (spec §14 : aucun secret en clair).
 * Comparaison insensible à la casse.
 *
 * NB : `key` masque aussi des champs métier légitimes (ex. `{ key: 'HOME' }` dans les
 * params d'une commande TV). C'est assumé : un log n'est pas une source de vérité,
 * et la prudence prime sur la lisibilité. Si un jour ça gêne pour un cas précis,
 * logger le champ sous un autre nom (`keyCode`, `remoteKey`…) plutôt que d'assouplir la liste.
 */
const DENY_KEYS = new Set([
  'token',
  'refresh_token',
  'key',
  'password',
  'secret',
  'authorization',
  'cert',
]);

const MAX_DEPTH = 6;

/**
 * Masque `user:pass` d'une URL (ex. `mqtt://user:pass@broker:1883`).
 * Le marqueur est `***` et non `[REDACTED]` : les crochets seraient
 * percent-encodés par `URL` dans la partie userinfo.
 */
export function redactUrl(url: string): string {
  const mask = '***';
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    if (parsed.username !== '') parsed.username = mask;
    if (parsed.password !== '') parsed.password = mask;
    return parsed.toString();
  } catch {
    // pas une URL parsable : repli textuel sur le motif `scheme://user:pass@`
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, `$1${mask}@`);
  }
}

/** Copie récursive avec masquage des clés sensibles (profondeur bornée, cycles coupés). */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date || value instanceof Error || Buffer.isBuffer(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = DENY_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

export function createLogger(driver: string): Logger {
  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    // extra d'abord : les champs réservés (ts/level/driver/msg) ne sont jamais écrasés
    const safeExtra =
      extra === undefined ? undefined : (redact(extra) as Record<string, unknown> | undefined);
    process.stdout.write(
      `${JSON.stringify({ ...safeExtra, ts: new Date().toISOString(), level, driver, msg })}\n`,
    );
  };
  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}
