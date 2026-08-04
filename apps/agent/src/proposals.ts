import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { unifiedDiff } from './diff.js';

/**
 * Propositions de changement de régulation (spec §11).
 *
 * L'invariant tient en une phrase : **rien ici n'écrit `config/regulation.yaml`**.
 * L'agent dépose un fichier dans `config/proposals/`, un humain le relit et
 * l'applique (`apply-proposal.ts`). C'est la traduction en code du principe n°1 —
 * un modèle non déterministe ne modifie pas les paramètres qui font tourner le
 * chauffage à trois heures du matin.
 *
 * Les propositions ne sont **pas versionnées** : `.gitignore` racine met `config/`
 * en allowlist (`config/*` ignoré, quelques exceptions nommées), donc
 * `config/proposals/` est ignoré sans qu'aucune règle ne soit à ajouter — vérifié
 * par `git check-ignore -v config/proposals/x.yaml`. C'est le bon défaut : une
 * proposition est un brouillon, seul son *résultat* (le yaml appliqué) se commite.
 */

/** Échec métier d'une proposition — l'appelant en fait une erreur d'outil MCP. */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

export const Proposal = z.object({
  createdAt: z.string().datetime(),
  /** Une phrase : ce que la proposition change, et pourquoi. */
  summary: z.string().min(1),
  /** Diff unifié entre le fichier actuel et le yaml proposé. */
  diff: z.string().min(1),
  /** Contenu complet du fichier proposé (jamais un fragment). */
  proposedYaml: z.string().min(1),
});
export type Proposal = z.infer<typeof Proposal>;

export interface WrittenProposal {
  path: string;
  proposal: Proposal;
}

/** Longueur max d'un résumé — c'est une phrase, pas un rapport. */
const SUMMARY_MAX = 200;
const SLUG_MAX = 48;

/** Résumé normalisé sur une seule ligne. */
function normalizeSummary(raw: string): string {
  const summary = raw.replace(/\s+/g, ' ').trim();
  if (summary.length === 0) {
    throw new ProposalError('un résumé d’une phrase est obligatoire', 'missing_summary');
  }
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary;
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug.length === 0 ? 'proposition' : slug;
}

/**
 * Horodatage de nom de fichier : l'ISO 8601 contient `:` et `.`, illégaux dans un
 * nom de fichier Windows (le dépôt se développe aussi sur la tour, spec §1).
 * L'ISO exact reste dans le contenu (`createdAt`).
 */
export function proposalFileName(now: Date, summary: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${slugify(summary)}.yaml`;
}

export interface WriteProposalOptions {
  /** Fichier de référence, lu seulement. */
  regulationConfigPath: string;
  proposalsDir: string;
  summary: string;
  /** Contenu complet proposé pour le fichier de régulation. */
  proposedYaml: string;
  now: Date;
}

export function writeProposal(options: WriteProposalOptions): WrittenProposal {
  const summary = normalizeSummary(options.summary);

  let current: string;
  try {
    current = readFileSync(options.regulationConfigPath, 'utf8');
  } catch {
    throw new ProposalError(
      `configuration de régulation illisible : ${options.regulationConfigPath}`,
      'config_unreadable',
    );
  }

  // Le yaml proposé doit être un document complet et valide : une proposition
  // qu'on ne peut pas appliquer telle quelle ferait perdre son temps à l'humain.
  let parsed: unknown;
  try {
    parsed = parseYaml(options.proposedYaml);
  } catch (err) {
    throw new ProposalError(
      `yaml proposé invalide : ${err instanceof Error ? err.message : String(err)}`,
      'invalid_yaml',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProposalError(
      'le yaml proposé doit être le contenu complet du fichier de régulation (un mapping), pas un fragment',
      'invalid_yaml_shape',
    );
  }

  const diff = unifiedDiff(current, options.proposedYaml, {
    fromFile: `${options.regulationConfigPath} (actuel)`,
    toFile: `${options.regulationConfigPath} (proposé)`,
  });
  if (diff === '') {
    throw new ProposalError(
      'la proposition est identique à la configuration actuelle : rien à proposer',
      'empty_diff',
    );
  }

  const proposal: Proposal = {
    createdAt: options.now.toISOString(),
    summary,
    diff,
    proposedYaml: options.proposedYaml,
  };

  const path = join(options.proposalsDir, proposalFileName(options.now, summary));
  mkdirSync(options.proposalsDir, { recursive: true });
  writeFileSync(path, stringifyYaml(proposal, { lineWidth: 0 }), 'utf8');
  return { path, proposal };
}

/** Relit une proposition déposée (CLI d'application). */
export function readProposal(path: string): Proposal {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ProposalError(`proposition introuvable : ${path}`, 'proposal_not_found');
  }
  const parsed = Proposal.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new ProposalError(
      `proposition hors contrat (${path}) : ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      'invalid_proposal',
    );
  }
  return parsed.data;
}
