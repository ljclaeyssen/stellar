import { describe, expect, it } from 'vitest';
import { redactText, redactValue, truncate } from './redaction.js';

/**
 * Le garde-fou secrets de l'affichage (spec §14).
 *
 * La procédure de setup manipule des tokens par construction : appairage TV, clé
 * Hue, refresh token Netatmo, tokens Midea. Ils finissent chiffrés — mais aucun
 * ne doit transiter en clair vers un navigateur, où il resterait dans un scroll
 * et dans une capture d'écran.
 */

describe('redactText', () => {
  it('masque une valeur de secret citée dans du texte', () => {
    const masked = redactText("l’appareil a répondu {token:'abcd1234'}");
    expect(masked).toContain('[REDACTED]');
    expect(masked).not.toContain('abcd1234');
  });

  it('masque les formes JSON, YAML et variables d’environnement', () => {
    const cases = [
      '{"refresh_token":"5f3a"}',
      "{ key: 'aaaa-bbbb' }",
      'ANTHROPIC_API_KEY=sk-ant-secret',
      'HUE_APP_KEY=Xy9zzz',
      'NETATMO_CLIENT_SECRET: hunter2',
      'password = hunter2',
    ];
    for (const line of cases) {
      const masked = redactText(line);
      expect(masked, line).toContain('[REDACTED]');
      for (const leak of ['5f3a', 'aaaa-bbbb', 'sk-ant-secret', 'Xy9zzz', 'hunter2']) {
        expect(masked, line).not.toContain(leak);
      }
    }
  });

  it('masque le user:pass d’une URL sans casser l’URL', () => {
    const masked = redactText('broker : mqtt://stellar:motdepasse@192.168.1.10:1883');
    expect(masked).not.toContain('motdepasse');
    expect(masked).toContain('192.168.1.10:1883');
  });

  it('laisse le texte ordinaire intact', () => {
    const text = 'Le bridge Hue répond sur https://192.168.1.20. On appaire maintenant ?';
    expect(redactText(text)).toBe(text);
  });

  it('ne masque pas un code de télécommande qui contient « key »', () => {
    // `KEYCODE_HOME` n'est pas une affectation de secret : sur-masquer partout
    // rendrait la conversation illisible là où il n'y a rien à cacher.
    expect(redactText('envoie KEYCODE_HOME à la TV')).toContain('KEYCODE_HOME');
  });
});

describe('redactValue', () => {
  it('masque les clés sensibles d’une structure, comme le logger', () => {
    const rendered = redactValue({ host: '192.168.1.42', token: 'zzz', nested: { key: 'yyy' } });
    expect(rendered).toContain('192.168.1.42');
    expect(rendered).not.toContain('zzz');
    expect(rendered).not.toContain('yyy');
  });
});

describe('truncate', () => {
  it('borne un contenu volumineux en annonçant ce qui manque', () => {
    const cut = truncate('x'.repeat(50), 10);
    expect(cut.startsWith('x'.repeat(10))).toBe(true);
    expect(cut).toContain('40 caractères tronqués');
  });

  it('ne touche pas à ce qui tient dans la limite', () => {
    expect(truncate('court', 10)).toBe('court');
  });
});
