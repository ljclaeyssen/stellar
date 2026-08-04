import { redact, redactUrl, REDACTED } from '@stellar/bus';

/**
 * Garde-fou secrets **de l'affichage**.
 *
 * Le logger de `@stellar/bus` protège déjà les logs (spec §14). Ici c'est l'écran
 * qu'on protège : l'assistant de setup manipule légitimement des tokens (pairing
 * TV, clé Hue, refresh token Netatmo), il les écrit dans des fichiers chiffrés —
 * mais rien ne justifie qu'un token complet s'affiche dans un navigateur, reste
 * dans un historique de scroll, ou parte dans une capture d'écran.
 *
 * Deux niveaux, tous deux adossés au logger :
 * - `redact()` pour les **structures** (les entrées de tools : `{ key: '…' }`) ;
 * - le motif ci-dessous pour le **texte libre**, que `redact()` ne peut pas voir —
 *   un token cité au fil d'une phrase ou dans un bloc de code reste du texte.
 *
 * La liste de clés est volontairement la même que celle du logger (`DENY_KEYS`),
 * plus les variantes d'environnement de ce dépôt (`ANTHROPIC_API_KEY`,
 * `HUE_APP_KEY`, `NETATMO_CLIENT_SECRET`…), qui sont des affectations `NOM=valeur`.
 * Sur-masquer est le comportement souhaité : un `[REDACTED]` de trop se relit,
 * un token de trop ne se reprend pas.
 */

/** Miroir textuel de `DENY_KEYS` du logger + suffixes des variables du dépôt. */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:token|password|secret|authorization|api[_-]?key|client[_-]?secret|app[_-]?key|cert)[A-Za-z0-9_.-]*|key`;

/** `token: 'abc'`, `"refresh_token":"abc"`, `HUE_APP_KEY=abc`, `key = abc`. */
const ASSIGNMENT = new RegExp(
  String.raw`(["'\x60]?\b(?:${SECRET_KEY})\b["'\x60]?\s*[:=]\s*)(` +
    String.raw`"[^"]*"|'[^']*'|\x60[^\x60]*\x60|[^\s,;)}\]]+)`,
  'gi',
);

/** Toute URL absolue — `redactUrl` n'y masque que le `user:pass@`. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;

/**
 * Masque les secrets d'un texte destiné à l'IHM.
 *
 * L'ordre compte : `redactUrl` a besoin d'URL intactes pour les parser (il masque
 * le `user:pass@`), donc il passe en premier ; le motif d'affectation repasse
 * ensuite sur tout, y compris sur ce qui reste des URL — un `?token=…` en query
 * string finit masqué lui aussi.
 */
export function redactText(text: string): string {
  return text
    .replace(URL_LIKE, (url) => redactUrl(url))
    .replace(ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

/** Rend une entrée de tool affichable : masquage structurel puis JSON lisible. */
export function redactValue(value: unknown): string {
  const safe = redact(value);
  const json = JSON.stringify(safe, null, 2);
  // `JSON.stringify` rend `undefined` pour une fonction ou un `undefined` nu.
  return redactText(json ?? String(value));
}

/**
 * Borne ce qui part dans le flux SSE. Un `cat` d'un fichier de fixtures ne doit
 * ni saturer le navigateur ni noyer la carte d'approbation qui le précède.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} caractères tronqués)`;
}
