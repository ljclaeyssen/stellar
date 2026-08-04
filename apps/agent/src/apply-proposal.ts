import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { readProposal } from './proposals.js';

/**
 * Application **humaine** d'une proposition de régulation (spec §11).
 *
 * C'est la moitié manquante de `propose_regulation_change` : l'agent dépose, un
 * humain lit le diff et tranche. Le `readline` est injecté pour que le test puisse
 * jouer les deux réponses possibles — un « non » qui laisserait quand même le
 * fichier modifié serait le pire bug imaginable de cette phase.
 *
 * Pas de sauvegarde `.bak` : `config/regulation.yaml` est versionné (spec §10), donc
 * `git diff` et `git checkout` sont déjà le filet, en mieux.
 */

export type ApplyOutcome = 'applied' | 'cancelled';

export type Confirm = (question: string) => Promise<boolean>;

export interface ApplyProposalOptions {
  proposalPath: string;
  regulationConfigPath: string;
  /** `--yes` : applique sans poser la question (usage scripté). */
  yes?: boolean;
  out?: (line: string) => void;
  /** Requis quand `yes` est faux. */
  confirm?: Confirm;
}

/** Confirmation interactive par readline — le défaut du CLI. */
export function createReadlineConfirm(): Confirm {
  return async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question} [o/N] `);
      return /^(o|oui|y|yes)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

export async function applyProposal(options: ApplyProposalOptions): Promise<ApplyOutcome> {
  const out =
    options.out ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const proposal = readProposal(options.proposalPath);

  out(`Proposition : ${options.proposalPath}`);
  out(`Déposée le  : ${proposal.createdAt}`);
  out(`Résumé      : ${proposal.summary}`);
  out(`Cible       : ${options.regulationConfigPath}`);
  out('');
  out(proposal.diff.trimEnd());
  out('');

  if (options.yes !== true) {
    const confirm = options.confirm;
    if (confirm === undefined) {
      throw new Error('confirmation impossible : ni --yes ni fonction de confirmation');
    }
    const accepted = await confirm('Appliquer cette proposition ?');
    if (!accepted) {
      out('Annulé — aucun fichier modifié.');
      return 'cancelled';
    }
  }

  writeFileSync(options.regulationConfigPath, proposal.proposedYaml, 'utf8');
  out(`Appliqué. Relis avec « git diff ${options.regulationConfigPath} », puis redémarre le core.`);
  return 'applied';
}
