import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@stellar/bus';
import type { NetatmoApiLike } from './api.js';
import {
  buildStationPercepts,
  buildThermostatPercepts,
  buildThermostatTopology,
  type Percept,
} from './mapping.js';

export interface VerifyOptions {
  api: NetatmoApiLike;
  apiUrl: string;
  /** Dossier des fixtures du driver — le dump y atterrit daté. */
  fixturesDir: string;
  logger: Logger;
}

export interface VerifySummary {
  dumpFile: string;
  home?: string;
  thermostats: string[];
  stations: string[];
  entityIds: string[];
}

/**
 * Étape 3 de la checklist de branchement matériel (docs/TESTING.md §3) :
 * **lecture seule**. On lit l'inventaire, l'état du chauffage et la station du
 * compte réel, on les enregistre en fixture datée et on résume ce qui en
 * sortirait sur le bus — sans rien piloter, sans toucher au bus MQTT.
 *
 * Le dump ne contient **aucun token** : la réponse `/oauth2/token` n'est jamais
 * enregistrée (spec §14). Il contient en revanche les adresses MAC des modules :
 * fichier à traiter comme le reste de `__fixtures__/`, dans un dépôt privé.
 *
 * Un rafraîchissement de token a lieu pendant l'opération (c'est inévitable) :
 * la rotation est donc bien réelle ici aussi, et le fichier de tokens est
 * réécrit. C'est voulu — `verify` prouve aussi que la persistance fonctionne.
 */
export async function verify(options: VerifyOptions): Promise<VerifySummary> {
  const { api, apiUrl, fixturesDir, logger } = options;

  const homes = await api.getHomesData();
  const topology = buildThermostatTopology(homes, logger);
  const status = topology === null ? null : await api.getHomeStatus(topology.homeId);
  const stations = await api.getStationsData();

  const percepts: Percept[] = [
    ...(topology !== null && status !== null
      ? buildThermostatPercepts(status, topology, logger)
      : []),
    ...buildStationPercepts(stations, { logger }),
  ];

  // `:` est interdit dans un nom de fichier Windows — l'ISO est aplati.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(fixturesDir, `verify-${stamp}.json`);
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    dumpFile,
    `${JSON.stringify(
      {
        _note:
          'Capture du compte Netatmo réel (stellar-netatmo verify, lecture seule). Comparer à __fixtures__/api/ et recaler le simulateur en cas d’écart. Aucun token n’est enregistré ici.',
        generatedAt: new Date().toISOString(),
        apiUrl,
        responses: {
          homesdata: homes,
          homestatus: status,
          getstationsdata: stations.map((station) => station.raw),
        },
        percepts,
      },
      null,
      2,
    )}\n`,
  );

  const summary: VerifySummary = {
    dumpFile,
    ...(topology === null ? {} : { home: topology.homeName }),
    thermostats: (topology?.rooms ?? []).map((room) => room.entityId),
    stations: stations.map((station) => station.stationName),
    entityIds: percepts.map((percept) => percept.entityId),
  };
  logger.info('verify terminé', { ...summary });
  return summary;
}
