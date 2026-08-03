import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, redact, redactUrl, REDACTED } from './logger.js';

function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('émet un objet JSON avec les champs de la spec §9', () => {
    const { lines, restore } = captureLines();
    createLogger('midea').info('bonjour', { entityId: 'clim_salon' });
    restore();

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      driver: 'midea',
      msg: 'bonjour',
      entityId: 'clim_salon',
    });
    expect(typeof entry['ts']).toBe('string');
  });

  it('n’écrase jamais les champs réservés avec les extras', () => {
    const { lines, restore } = captureLines();
    createLogger('midea').warn('vrai message', {
      driver: 'pirate',
      level: 'debug',
      msg: 'faux message',
      ts: 'hier',
    });
    restore();

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry['driver']).toBe('midea');
    expect(entry['level']).toBe('warn');
    expect(entry['msg']).toBe('vrai message');
    expect(entry['ts']).not.toBe('hier');
  });

  it('redacte les secrets, y compris imbriqués et dans les tableaux', () => {
    const { lines, restore } = captureLines();
    createLogger('netatmo').error('oups', {
      token: 'abc',
      config: { refresh_token: 'rrr', Password: 'p', url: 'https://api.netatmo.com' },
      headers: [{ Authorization: 'Bearer x' }],
      params: { key: 'HOME', targetTemp: 21 },
    });
    restore();

    const raw = lines[0] ?? '';
    expect(raw).not.toContain('abc');
    expect(raw).not.toContain('rrr');
    expect(raw).not.toContain('Bearer x');

    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry['token']).toBe(REDACTED);
    expect(entry['config']).toMatchObject({
      refresh_token: REDACTED,
      Password: REDACTED,
      url: 'https://api.netatmo.com',
    });
    expect(entry['headers']).toEqual([{ Authorization: REDACTED }]);
    // `key` est redacté même quand c'est un champ métier (touche TV) : choix assumé
    expect(entry['params']).toEqual({ key: REDACTED, targetTemp: 21 });
  });

  it('ne casse pas sur une structure circulaire', () => {
    const { lines, restore } = captureLines();
    const cyclic: Record<string, unknown> = { name: 'boucle' };
    cyclic['self'] = cyclic;
    expect(() => createLogger('fake').debug('cycle', cyclic)).not.toThrow();
    restore();
    expect(lines[0]).toContain('Circular');
  });
});

describe('redact', () => {
  it('laisse les scalaires intacts et borne la profondeur', () => {
    expect(redact(42)).toBe(42);
    expect(redact('coucou')).toBe('coucou');
    expect(redact(null)).toBeNull();
    const deep = { a: { b: { c: { d: { e: { f: { g: 'trop loin' } } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('TRUNCATED');
  });
});

describe('redactUrl', () => {
  it('masque user:pass', () => {
    const masked = redactUrl('mqtt://bob:hunter2@broker.lan:1883');
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('bob');
    expect(masked).toContain('broker.lan:1883');
  });

  it('laisse une URL sans credentials intacte', () => {
    expect(redactUrl('mqtt://127.0.0.1:1883')).toBe('mqtt://127.0.0.1:1883');
  });

  it('ne casse pas sur une chaîne non parsable', () => {
    expect(redactUrl('pas une url')).toBe('pas une url');
  });
});
