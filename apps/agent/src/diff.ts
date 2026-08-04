/**
 * Diff unifié minimal, sans dépendance.
 *
 * Pourquoi pas une lib : une proposition de l'agent porte un diff que **l'humain
 * relit avant d'appliquer** (spec §11). C'est une trentaine de lignes d'algorithme
 * archi-connu sur un fichier de 80 lignes ; ajouter une dépendance de plus au
 * dépôt pour ça serait un mauvais échange.
 */

export interface UnifiedDiffOptions {
  /** Étiquette de gauche, affichée après `---`. */
  fromFile?: string;
  /** Étiquette de droite, affichée après `+++`. */
  toFile?: string;
  /** Lignes de contexte autour de chaque changement. */
  context?: number;
}

interface Op {
  sign: ' ' | '-' | '+';
  text: string;
}

/**
 * Au-delà de ce produit `lignes(avant) × lignes(après)`, la table LCS coûte trop
 * cher : on rend alors un diff « tout remplacer », correct mais grossier. Un
 * `regulation.yaml` fait ~80 lignes — on n'y touchera jamais.
 */
const LCS_CELLS_MAX = 4_000_000;

/** Accès borné : les index sont prouvés en bornes, l'exception marque un bug, pas un cas. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index hors bornes : ${index}`);
  return item;
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body === '' ? [] : body.split('\n');
}

/** Script d'édition : suite d'opérations transformant `a` en `b`. */
function editScript(a: string[], b: string[]): Op[] {
  // Préfixe et suffixe communs retirés d'abord : sur une édition de deux lignes
  // dans un fichier de config, la table LCS tombe à quelques cellules.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: Op[] = a.slice(0, head).map((text): Op => ({ sign: ' ', text }));

  if (midA.length * midB.length > LCS_CELLS_MAX) {
    ops.push(...midA.map((text): Op => ({ sign: '-', text })));
    ops.push(...midB.map((text): Op => ({ sign: '+', text })));
  } else {
    // LCS classique, table à plat : `lcs(i, j)` = longueur de la plus longue
    // sous-suite commune des suffixes `midA[i…]` et `midB[j…]`.
    const width = midB.length + 1;
    const table = new Array<number>((midA.length + 1) * width).fill(0);
    const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] =
          at(midA, i) === at(midB, j)
            ? lcs(i + 1, j + 1) + 1
            : Math.max(lcs(i + 1, j), lcs(i, j + 1));
      }
    }

    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (at(midA, i) === at(midB, j)) {
        ops.push({ sign: ' ', text: at(midA, i) });
        i++;
        j++;
      } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
        ops.push({ sign: '-', text: at(midA, i) });
        i++;
      } else {
        ops.push({ sign: '+', text: at(midB, j) });
        j++;
      }
    }
    for (; i < midA.length; i++) ops.push({ sign: '-', text: at(midA, i) });
    for (; j < midB.length; j++) ops.push({ sign: '+', text: at(midB, j) });
  }

  ops.push(...a.slice(a.length - tail).map((text): Op => ({ sign: ' ', text })));
  return ops;
}

/**
 * Rend un diff unifié, ou **la chaîne vide** si les deux textes sont identiques —
 * c'est le signal « rien à proposer » exploité par l'appelant.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const context = options.context ?? 3;
  const ops = editScript(splitLines(before), splitLines(after));
  if (!ops.some((op) => op.sign !== ' ')) return '';

  // Opérations à conserver : tout changement, plus `context` lignes autour.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.sign === ' ') return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });

  const lines: string[] = [`--- ${options.fromFile ?? 'a'}`, `+++ ${options.toFile ?? 'b'}`];

  let index = 0;
  let lineA = 1;
  let lineB = 1;
  while (index < ops.length) {
    if (keep[index] !== true) {
      const op = at(ops, index);
      if (op.sign !== '+') lineA++;
      if (op.sign !== '-') lineB++;
      index++;
      continue;
    }

    const startA = lineA;
    const startB = lineB;
    let countA = 0;
    let countB = 0;
    const body: string[] = [];
    while (index < ops.length && keep[index] === true) {
      const op = at(ops, index);
      body.push(`${op.sign}${op.text}`);
      if (op.sign !== '+') {
        countA++;
        lineA++;
      }
      if (op.sign !== '-') {
        countB++;
        lineB++;
      }
      index++;
    }
    // Convention unified diff : un côté vide commence à la ligne 0.
    const headA = `${countA === 0 ? 0 : startA},${countA}`;
    const headB = `${countB === 0 ? 0 : startB},${countB}`;
    lines.push(`@@ -${headA} +${headB} @@`);
    lines.push(...body);
  }

  return `${lines.join('\n')}\n`;
}
