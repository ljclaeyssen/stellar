/** Logs JSON structurés sur stdout — règle commune drivers (spec §9). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(driver: string): Logger {
  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    // extra d'abord : les champs réservés (ts/level/driver/msg) ne sont jamais écrasés
    process.stdout.write(
      `${JSON.stringify({ ...extra, ts: new Date().toISOString(), level, driver, msg })}\n`,
    );
  };
  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}
