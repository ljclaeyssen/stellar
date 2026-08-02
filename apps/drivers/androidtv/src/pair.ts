import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createAndroidRemote } from '@kud/androidtv-remote';
import type { Logger } from '@stellar/bus';

/**
 * Pairing une seule fois : la TV affiche un code à l'écran, on le saisit,
 * le certificat TLS est persisté pour toutes les connexions suivantes.
 */
export async function pair(tvHost: string, certFile: string, logger: Logger): Promise<void> {
  const remote = createAndroidRemote(tvHost, { service_name: 'stellar' });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  remote.on('secret', () => {
    void (async () => {
      const code = await rl.question('Code de pairing affiché sur la TV : ');
      remote.sendCode(code.trim());
    })();
  });

  await new Promise<void>((resolve, reject) => {
    remote.on('ready', () => resolve());
    remote.on('error', (err) => reject(err));
    void remote.start();
  });

  const cert = remote.getCertificate();
  await mkdir(dirname(certFile), { recursive: true });
  await writeFile(certFile, JSON.stringify(cert, null, 2), { mode: 0o600 });
  logger.info('pairing réussi, certificat persisté', { certFile });
  logger.warn('penser à chiffrer ce fichier avec sops/age avant tout backup');

  rl.close();
  remote.stop();
}
