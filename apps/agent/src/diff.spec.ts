import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './diff.js';

/**
 * Le diff est ce que l'humain relit avant d'appliquer une proposition : s'il ment,
 * tout le garde-fou de la spec §11 ment avec lui.
 */
describe('diff unifié', () => {
  it('rend la chaîne vide quand rien ne change', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
    // Fin de ligne Windows vs Unix : ce n'est pas un changement de contenu.
    expect(unifiedDiff('a\r\nb\r\n', 'a\nb\n')).toBe('');
  });

  it('montre une modification avec son contexte et ses en-têtes', () => {
    const before = ['un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept'].join('\n');
    const after = before.replace('quatre', 'QUATRE');
    const diff = unifiedDiff(before, after, { fromFile: 'avant', toFile: 'après' });

    expect(diff.startsWith('--- avant\n+++ après\n')).toBe(true);
    expect(diff).toContain('-quatre');
    expect(diff).toContain('+QUATRE');
    // 3 lignes de contexte de chaque côté, une seule ligne changée.
    expect(diff).toContain('@@ -1,7 +1,7 @@');
    expect(diff.split('\n').filter((line) => line.startsWith(' '))).toHaveLength(6);
  });

  it('gère ajouts, suppressions et fichiers vides', () => {
    expect(unifiedDiff('', 'nouveau\n')).toContain('+nouveau');
    expect(unifiedDiff('', 'nouveau\n')).toContain('@@ -0,0 +1,1 @@');
    expect(unifiedDiff('ancien\n', '')).toContain('-ancien');

    const diff = unifiedDiff('a\nb\nc\n', 'a\nc\n');
    expect(diff).toContain('-b');
    expect(diff).not.toContain('+b');
  });

  it('sépare les changements éloignés en plusieurs hunks', () => {
    const before = Array.from({ length: 40 }, (_unused, i) => `ligne ${i}`).join('\n');
    const after = before.replace('ligne 1\n', 'LIGNE 1\n').replace('ligne 35', 'LIGNE 35');
    const diff = unifiedDiff(before, after);
    expect(diff.split('\n').filter((line) => line.startsWith('@@'))).toHaveLength(2);
  });
});
