import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@stellar/bus';
import { statusToClimateValue, type MideaStatus } from '@stellar/midea-protocol';
import type { MideaUnits } from './config.js';
import { defaultApplianceFactory, temperatureIdOf, type ApplianceFactory } from './driver.js';

export interface VerifyOptions {
  units: MideaUnits;
  /** Dossier des fixtures du driver — le dump y atterrit daté. */
  fixturesDir: string;
  logger: Logger;
  /** Couture ADR-010 : le fake du protocole prend la place du dongle en test. */
  createAppliance?: ApplianceFactory;
}

export interface VerifyUnitSummary {
  entityId: string;
  room: string;
  temperatureId: string;
  ok: boolean;
  /** Renseigné si `ok` — de quoi juger d'un coup d'œil que l'unité dit vrai. */
  climate?: ReturnType<typeof statusToClimateValue>;
  error?: string;
}

export interface VerifySummary {
  dumpFile: string;
  units: VerifyUnitSummary[];
  reachable: number;
}

/**
 * Étape 3 de la checklist de branchement matériel (docs/TESTING.md §3) :
 * **lecture seule**. Un `getStatus` par unité, enregistré en fixture datée, et un
 * résumé par unité — sans rien piloter, sans toucher au bus MQTT.
 *
 * Le dump est la première trame *réelle* du parc : c'est lui qui servira à recaler
 * les fixtures de `packages/midea-protocol/__fixtures__/`, dérivées jusqu'ici de
 * la seule documentation de node-mideahvac.
 *
 * **Aucun secret n'y figure** : ni `token`, ni `key`, ni même l'`id` de l'unité
 * (spec §14). Ces trois valeurs sont irremplaçables — Midea a fermé ses API de
 * délivrance — et un dump de fixtures a vocation à être lu, copié, joint à un
 * rapport. Le `host` est conservé : c'est une IP de LAN privé, et sans elle le
 * dump ne dit plus de quelle unité il parle.
 */
export async function verify(options: VerifyOptions): Promise<VerifySummary> {
  const { units, fixturesDir, logger } = options;
  const createAppliance = options.createAppliance ?? defaultApplianceFactory;

  const results: { summary: VerifyUnitSummary; host: string; status: MideaStatus | null }[] = [];

  for (const unit of units) {
    const appliance = createAppliance(unit);
    const base = {
      entityId: unit.entityId,
      room: unit.room,
      temperatureId: temperatureIdOf(unit),
    };
    try {
      await appliance.connect();
      const status = await appliance.getStatus();
      results.push({
        summary: { ...base, ok: true, climate: statusToClimateValue(status) },
        host: unit.host,
        status,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('unité injoignable pendant verify', { entityId: unit.entityId, error });
      results.push({ summary: { ...base, ok: false, error }, host: unit.host, status: null });
    } finally {
      appliance.disconnect();
    }
  }

  // `:` est interdit dans un nom de fichier Windows — l'ISO est aplati.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(fixturesDir, `verify-${stamp}.json`);
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    dumpFile,
    `${JSON.stringify(
      {
        _note:
          'Capture des clims Midea réelles (stellar-midea verify, lecture seule). Recaler packages/midea-protocol/__fixtures__/ sur ces statuts. Aucun token, key ni id d’unité n’est enregistré ici.',
        generatedAt: new Date().toISOString(),
        units: results.map((result) => ({
          entityId: result.summary.entityId,
          room: result.summary.room,
          host: result.host,
          ok: result.summary.ok,
          ...(result.summary.error === undefined ? {} : { error: result.summary.error }),
          status: result.status,
          ...(result.summary.climate === undefined ? {} : { climate: result.summary.climate }),
        })),
      },
      null,
      2,
    )}\n`,
  );

  const summary: VerifySummary = {
    dumpFile,
    units: results.map((result) => result.summary),
    reachable: results.filter((result) => result.summary.ok).length,
  };
  logger.info('verify terminé', {
    dumpFile,
    reachable: summary.reachable,
    total: summary.units.length,
  });
  return summary;
}
