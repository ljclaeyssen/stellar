import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@stellar/bus';
import type { HueApiLike } from './api.js';
import { buildInventory } from './mapping.js';

export interface VerifyOptions {
  api: HueApiLike;
  bridgeUrl: string;
  /** Dossier des fixtures du driver — le dump y atterrit daté. */
  fixturesDir: string;
  logger: Logger;
}

export interface VerifySummary {
  dumpFile: string;
  lights: number;
  plugs: number;
  rooms: string[];
  entityIds: string[];
}

/**
 * Étape 3 de la checklist de branchement matériel (docs/TESTING.md §3) :
 * **lecture seule**. On interroge l'inventaire du bridge réel, on l'enregistre
 * en fixture datée et on résume ce qui en sortirait sur le bus — sans rien
 * piloter, sans ouvrir le flux d'événements, sans toucher au bus MQTT.
 *
 * Les ressources dumpées sont celles **validées** par les schémas zod (en
 * `.passthrough()`, donc champs inconnus conservés) : une ressource hors
 * contrat n'apparaît pas dans le dump mais a produit un `warn` — c'est
 * exactement l'écart à recaler dans `__fixtures__/clipv2/`.
 */
export async function verify(options: VerifyOptions): Promise<VerifySummary> {
  const { api, bridgeUrl, fixturesDir, logger } = options;

  const [lights, devices, rooms] = await Promise.all([
    api.getLights(),
    api.getDevices(),
    api.getRooms(),
  ]);
  const entities = buildInventory({ lights, devices, rooms, logger });

  // `:` est interdit dans un nom de fichier Windows — l'ISO est aplati.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(fixturesDir, `verify-${stamp}.json`);
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    dumpFile,
    `${JSON.stringify(
      {
        _note:
          'Capture du bridge réel (stellar-hue verify, lecture seule). Comparer à __fixtures__/clipv2/ et recaler le simulateur en cas d’écart.',
        generatedAt: new Date().toISOString(),
        bridgeUrl,
        resources: { light: lights, device: devices, room: rooms },
        inventory: entities,
      },
      null,
      2,
    )}\n`,
  );

  const summary: VerifySummary = {
    dumpFile,
    lights: entities.filter((entity) => entity.kind === 'light').length,
    plugs: entities.filter((entity) => entity.kind === 'plug').length,
    rooms: [...new Set(rooms.map((room) => room.metadata.name))].sort(),
    entityIds: entities.map((entity) => entity.entityId),
  };
  logger.info('verify terminé', { ...summary });
  return summary;
}
