import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from './apply-proposal.js';
import { ProposalError, writeProposal } from './proposals.js';

/**
 * L'APPLICATION EST HUMAINE (spec §11).
 *
 * Deux scénarios, un seul enjeu : un « non » ne doit rien écrire. Le `readline` est
 * injecté — un test qui attendrait une vraie saisie ne serait pas un test.
 */

const PROD_CONFIG = fileURLToPath(new URL('../../../config/regulation.yaml', import.meta.url));

describe('stellar-agent apply', () => {
  let sandbox: string;
  let configPath: string;
  let proposalsDir: string;
  let original: string;
  let proposalPath: string;
  let proposedYaml: string;
  let out: string[];

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'stellar-agent-apply-'));
    configPath = join(sandbox, 'regulation.yaml');
    proposalsDir = join(sandbox, 'proposals');
    mkdirSync(proposalsDir, { recursive: true });
    copyFileSync(PROD_CONFIG, configPath);
    original = readFileSync(configPath, 'utf8');
    proposedYaml = original.replace('hysteresis: 0.4', 'hysteresis: 0.3');

    const written = writeProposal({
      regulationConfigPath: configPath,
      proposalsDir,
      summary: 'Resserrer l’hystérésis à 0,3 °C',
      proposedYaml,
      now: new Date('2026-08-04T09:15:30.500Z'),
    });
    proposalPath = written.path;
    out = [];
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('montre le diff et remplace le fichier avec --yes', async () => {
    const outcome = await applyProposal({
      proposalPath,
      regulationConfigPath: configPath,
      yes: true,
      out: (line) => out.push(line),
    });

    expect(outcome).toBe('applied');
    expect(readFileSync(configPath, 'utf8')).toBe(proposedYaml);

    const printed = out.join('\n');
    expect(printed).toContain('Resserrer l’hystérésis');
    expect(printed).toContain('-hysteresis: 0.4');
    expect(printed).toContain('+hysteresis: 0.3');
    expect(printed).toContain('git diff');
  });

  it('ne touche à rien quand la confirmation est refusée', async () => {
    const asked: string[] = [];
    const outcome = await applyProposal({
      proposalPath,
      regulationConfigPath: configPath,
      out: (line) => out.push(line),
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(false);
      },
    });

    expect(outcome).toBe('cancelled');
    expect(asked).toHaveLength(1);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(out.join('\n')).toContain('Annulé');
  });

  it('applique après une confirmation positive', async () => {
    const outcome = await applyProposal({
      proposalPath,
      regulationConfigPath: configPath,
      out: (line) => out.push(line),
      confirm: () => Promise.resolve(true),
    });

    expect(outcome).toBe('applied');
    expect(readFileSync(configPath, 'utf8')).toBe(proposedYaml);
  });

  it('refuse une proposition absente ou hors contrat', async () => {
    await expect(
      applyProposal({
        proposalPath: join(proposalsDir, 'inexistante.yaml'),
        regulationConfigPath: configPath,
        yes: true,
        out: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProposalError);

    const junk = join(proposalsDir, 'junk.yaml');
    writeFileSync(junk, 'summary: sans diff ni yaml proposé\n', 'utf8');
    await expect(
      applyProposal({
        proposalPath: junk,
        regulationConfigPath: configPath,
        yes: true,
        out: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProposalError);

    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });
});
