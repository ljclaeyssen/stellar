import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createAndroidRemote } from '@kud/androidtv-remote';
import type { Logger } from '@stellar/bus';

/**
 * Pairing une seule fois : la TV affiche un code à l'écran, on le saisit,
 * le certificat TLS est persisté pour toutes les connexions suivantes.
 *
 * `start()` porte tout le résultat : la lib n'émet ni `ready` ni `error` quand
 * le pairing échoue (code erroné, TV injoignable) — elle résout simplement
 * `false`. Attendre un événement, comme le faisait la version précédente,
 * laissait la commande pendue indéfiniment.
 */
export async function pair(tvHost: string, certFile: string, logger: Logger): Promise<void> {
  const remote = createAndroidRemote(tvHost, { service_name: 'stellar' });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Un EventEmitter sans écouteur `error` lève l'erreur : on en garde un.
  remote.on('error', (err) => logger.error('erreur pendant le pairing', { error: err.message }));

  // La saisie se fait pendant que `start()` est en cours : c'est cet appel qui
  // émet `secret` une fois le code affiché sur la TV.
  remote.on('secret', () => {
    void (async () => {
      const code = await rl.question('Code de pairing affiché sur la TV : ');
      remote.sendCode(code.trim());
    })().catch((err) => logger.error('saisie du code impossible', { error: String(err) }));
  });

  const ok = await remote.start();
  if (!ok) {
    rl.close();
    remote.stop();
    logger.error(`pairing échoué — code erroné ou TV injoignable (${tvHost})`);
    process.exit(1);
  }

  const cert = remote.getCertificate();
  await mkdir(dirname(certFile), { recursive: true });
  await writeFile(certFile, JSON.stringify(cert, null, 2), { mode: 0o600 });
  logger.info('pairing réussi, certificat persisté', { certFile });
  logger.warn('penser à chiffrer ce fichier avec sops/age avant tout backup');

  rl.close();
  remote.stop();
}
