#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createAndroidRemote } from '@kud/androidtv-remote';
import { z } from 'zod';
import { createBus, createLogger } from '@stellar/bus';
import { loadConfig } from './config.js';
import { DRIVER_NAME, startAndroidTvDriver } from './driver.js';
import { pair } from './pair.js';

const logger = createLogger(DRIVER_NAME);

/**
 * Un certificat amputé (fichier tronqué, JSON valide mais vide) ferait repartir
 * la lib en *pairing* silencieusement, qui échouerait sans code saisi. On préfère
 * un message net à une boucle inexplicable.
 */
const CertificateFile = z.object({ key: z.string().min(1), cert: z.string().min(1) });

/** Backoff de reconnexion (règle commune drivers, spec §9). */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Délai au-delà duquel un arrêt propre est abandonné au profit d'un exit brutal. */
const SHUTDOWN_GRACE_MS = 5_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function readCertificate(certFile: string): Promise<z.infer<typeof CertificateFile>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(certFile, 'utf8'));
  } catch {
    logger.error(
      `certificat introuvable ou illisible (${certFile}) — lancer d'abord: stellar-androidtv pair`,
    );
    process.exit(1);
  }
  const parsed = CertificateFile.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      `certificat invalide/corrompu (${certFile}) — relancer le pairing: stellar-androidtv pair`,
    );
    process.exit(1);
  }
  return parsed.data;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const cert = await readCertificate(config.certFile);

  const bus = await createBus({
    url: config.mqttUrl,
    clientId: `${DRIVER_NAME}-driver`,
    driver: DRIVER_NAME,
  });

  const remote = createAndroidRemote(config.tvHost, { cert, service_name: 'stellar' });
  await startAndroidTvDriver({
    bus,
    remote,
    entityId: config.entityId,
    room: config.room,
    logger,
  });

  let stopping = false;
  let supervising = false;
  let attempt = 0;

  /**
   * Boucle de supervision de la session TV, **single-flight**.
   *
   * `remote.start()` ne rejette jamais : la lib avale tout et résout `false`.
   * Elle ne réessaie pas non plus une connexion *initiale* ratée (TV éteinte au
   * démarrage) — d'où cette boucle. Une fois la session établie, la lib gère
   * elle-même ses reconnexions internes (~1 s) ; on sort donc dès le premier
   * `true` et on ne repasse ici que sur signal de mort (`error`/`unpaired`).
   *
   * `remote.stop()` avant chaque `start()` : chaque `start()` instancie un
   * nouveau remoteManager sans arrêter l'ancien — sans ça on accumule des
   * sessions TLS zombies et des événements dupliqués.
   */
  const superviseStart = async (): Promise<void> => {
    if (supervising || stopping) return;
    supervising = true;
    try {
      while (!stopping) {
        remote.stop();
        const started = await remote.start();
        if (started) {
          attempt = 0;
          logger.info('connecté à la TV', { host: config.tvHost });
          return;
        }
        attempt += 1;
        const delayMs = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempt - 1));
        // Service maison : on ne renonce jamais, la TV finira par répondre.
        logger.warn('connexion à la TV échouée, nouvelle tentative', { attempt, delayMs });
        await wait(delayMs);
      }
    } finally {
      supervising = false;
    }
  };

  remote.on('error', (err: Error) => {
    logger.error('erreur session TV, reconnexion', { error: err.message });
    void superviseStart();
  });
  remote.on('unpaired', () => {
    // `unpaired` est émis sur TOUT ECONNRESET (TV débranchée, reboot) : ce n'est
    // pas une preuve de révocation du certificat. Sortir du process ici (ancien
    // comportement) transformait un simple reset TCP en panne du driver.
    logger.warn(
      'connexion perdue (unpaired peut être un simple reset TCP) — reconnexion ; si le message persiste après redémarrage de la TV, relancer le pairing (stellar-androidtv pair)',
    );
    void superviseStart();
  });

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('arrêt demandé', { signal });
    // Filet : si le broker ou la socket TLS ne rendent pas la main, on sort quand même.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    void (async () => {
      remote.stop();
      await bus.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  void superviseStart();
}

// Un bug non rattrapé ne doit pas laisser un process à moitié vivant : on sort
// en erreur, la supervision (systemd) relance.
process.on('unhandledRejection', (reason) => {
  logger.error('rejet non géré', { error: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('exception non gérée', { error: err.message });
  process.exit(1);
});

const command = process.argv[2] ?? 'run';
if (command === 'pair') {
  const config = loadConfig();
  await pair(config.tvHost, config.certFile, logger);
  process.exit(0);
} else if (command === 'run') {
  await run();
} else {
  logger.error(`commande inconnue: ${command} (attendu: run | pair)`);
  process.exit(1);
}
