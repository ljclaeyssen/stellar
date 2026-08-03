import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import mqtt from 'mqtt';
import type { Logger } from '@stellar/bus';

export interface DumpOptions {
  mqttUrl: string;
  baseTopic: string;
  durationMs: number;
  /** Dossier des fixtures du driver — le dump y atterrit daté. */
  fixturesDir: string;
  logger: Logger;
}

export interface DumpedMessage {
  topic: string;
  receivedAt: string;
  retain: boolean;
  /** Payload JSON quand c'en est, sinon le texte brut (availability « legacy »). */
  json?: unknown;
  text?: string;
}

export interface DumpSummary {
  dumpFile: string;
  messages: number;
  /** friendlyName déduits des topics — la liste à recopier dans la table. */
  friendlyNames: string[];
  topics: string[];
}

/**
 * Étape 3 de la checklist de branchement matériel (docs/TESTING.md §3),
 * transposée à Z2M : il n'y a **rien à appairer** côté Stellar (c'est Z2M qui
 * appaire les objets), donc pas de commande `pair`. Le `verify` de cette phase,
 * c'est l'observation des topics réels : on écoute `<base>/#` pendant quelques
 * dizaines de secondes, **en lecture seule**, et on enregistre tout en fixture
 * datée. De là se recalent `__fixtures__/` et `config/z2m-mapping.json`.
 *
 * Connexion MQTT nue et non le bus : cet outil ne doit rien annoncer sur
 * `home/health/z2m` — un observateur n'est pas un driver en service.
 */
export async function dump(options: DumpOptions): Promise<DumpSummary> {
  const { mqttUrl, baseTopic, durationMs, fixturesDir, logger } = options;
  const client = mqtt.connect(mqttUrl, {
    clientId: `stellar-z2m-dump-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
  });
  client.on('error', (err: Error) => logger.warn('mqtt error', { error: err.message }));

  const messages: DumpedMessage[] = [];
  client.on('message', (topic, payload, packet) => {
    const text = payload.toString();
    let json: unknown;
    let parsed = false;
    try {
      json = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
    messages.push({
      topic,
      receivedAt: new Date().toISOString(),
      retain: packet.retain,
      ...(parsed ? { json } : { text }),
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    client.once('error', onError);
    client.once('connect', () => {
      client.removeListener('error', onError);
      resolve();
    });
  });
  await client.subscribeAsync(`${baseTopic}/#`, { qos: 1 });
  logger.info('écoute des topics Zigbee2MQTT (lecture seule)', { baseTopic, durationMs });
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  await client.endAsync();

  const friendlyNames = [
    ...new Set(
      messages
        .map((message) => message.topic.slice(baseTopic.length + 1))
        .filter((relative) => relative !== '' && !relative.startsWith('bridge'))
        .map((relative) => relative.replace(/\/(availability|set|get)$/, '')),
    ),
  ].sort();

  // `:` est interdit dans un nom de fichier Windows — l'ISO est aplati.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(fixturesDir, `dump-${stamp}.json`);
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    dumpFile,
    `${JSON.stringify(
      {
        _note:
          'Capture brute de Zigbee2MQTT (stellar-z2m dump, lecture seule). Recaler __fixtures__/ et config/z2m-mapping.json sur ce contenu.',
        generatedAt: new Date().toISOString(),
        baseTopic,
        durationMs,
        friendlyNames,
        messages,
      },
      null,
      2,
    )}\n`,
  );

  const summary: DumpSummary = {
    dumpFile,
    messages: messages.length,
    friendlyNames,
    topics: [...new Set(messages.map((message) => message.topic))].sort(),
  };
  logger.info('dump terminé', { ...summary });
  return summary;
}
