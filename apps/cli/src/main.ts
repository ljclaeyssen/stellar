#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Command as Cli } from 'commander';
import { createBus, type Bus } from '@stellar/bus';
import { Health, Selector, healthTopic } from '@stellar/contracts';
import { idleWindow } from './idle-window.js';

const program = new Cli();
program
  .name('stellar')
  .description('Inspection du bus Stellar : états, commandes, santé des drivers')
  .option('-u, --url <url>', 'URL du broker MQTT', 'mqtt://localhost:1883');

async function connect(): Promise<Bus> {
  const { url } = program.opts<{ url: string }>();
  return createBus({ url, clientId: `cli-${process.pid}`, driver: 'cli' });
}

/** Erreur d'usage : message lisible, pas de stack. */
function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/**
 * Ferme la session en effaçant la trace `home/health/cli`.
 *
 * Le bus publie un health retained à la connexion : un outil éphémère n'a rien à
 * faire dans le magasin d'états, chaque invocation du CLI y laisserait un fantôme.
 * On publie donc un payload vide retained (= suppression côté broker), puis on
 * termine la connexion proprement — un DISCONNECT normal supprime aussi le LWT.
 *
 * On n'appelle volontairement PAS `bus.close()` : il republie un health `offline`
 * retained, qui ressusciterait exactement la trace qu'on veut effacer.
 * Palliatif — la vraie correction est une option `publishHealth: false` côté bus.
 */
async function closeQuietly(bus: Bus): Promise<void> {
  await bus.client.publishAsync(healthTopic('cli'), '', { retain: true, qos: 1 });
  await bus.client.endAsync();
}

program
  .command('states')
  .description('affiche les états (retained) filtrés par sélecteur, --follow pour suivre')
  .option('-k, --kind <kind>')
  .option('-r, --room <room>')
  .option('-d, --driver <driver>')
  .option('-f, --follow', 'rester abonné et afficher les mises à jour', false)
  .action(async (opts: { kind?: string; room?: string; driver?: string; follow: boolean }) => {
    const selector = Selector.parse({ kind: opts.kind, room: opts.room, driver: opts.driver });
    const bus = await connect();
    const burst = idleWindow();
    await bus.onState(selector, (entity) => {
      burst.bump();
      console.log(JSON.stringify(entity));
    });
    if (!opts.follow) {
      await burst.done;
      await closeQuietly(bus);
    }
  });

program
  .command('cmd')
  .description('envoie une commande et attend son ack')
  .argument('<driver>', 'driver destinataire')
  .argument('<entityId>', 'entité cible (ex. clim_salon)')
  .argument('<action>', 'action (ex. set)')
  .argument('[params]', 'params JSON', '{}')
  .option('-t, --timeout <ms>', "timeout d'ack en ms", '5000')
  .action(
    async (
      driver: string,
      entityId: string,
      action: string,
      params: string,
      opts: { timeout: string },
    ) => {
      // Tout ce qui peut échouer sur une faute de frappe est validé avant de
      // toucher au broker.
      const timeoutMs = Number(opts.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        fail(`--timeout invalide : "${opts.timeout}" (attendu : un entier de millisecondes > 0)`);
        return;
      }

      let parsedParams: Record<string, unknown>;
      try {
        parsedParams = JSON.parse(params) as Record<string, unknown>;
      } catch (err) {
        fail(`params JSON illisible : ${(err as Error).message}\n  reçu : ${params}`);
        return;
      }

      const bus = await connect();
      try {
        const ack = await bus.sendCommand(
          {
            id: randomUUID(),
            target: entityId,
            action,
            params: parsedParams,
            issuedBy: 'cli',
            ts: new Date().toISOString(),
          },
          { driver, timeoutMs },
        );
        console.log(JSON.stringify(ack));
        process.exitCode = ack.status === 'ok' ? 0 : 1;
      } catch (err) {
        // Cas courant : aucun ack en `timeoutMs` (driver absent ou muet).
        fail(`commande échouée : ${(err as Error).message}`);
      } finally {
        await closeQuietly(bus);
      }
    },
  );

program
  .command('health')
  .description('affiche le statut online/offline des drivers')
  .option('-f, --follow', 'rester abonné', false)
  .action(async (opts: { follow: boolean }) => {
    const bus = await connect();
    const burst = idleWindow();
    await bus.client.subscribeAsync(healthTopic('+'), { qos: 1 });
    bus.client.on('message', (topic, payload) => {
      burst.bump();
      // Payload vide = effacement d'un retained (cf. closeQuietly), rien à afficher.
      if (payload.length === 0) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString());
      } catch {
        console.error(`payload illisible sur ${topic}`);
        return;
      }
      const parsed = Health.safeParse(raw);
      if (!parsed.success) {
        console.error(
          `health non conforme sur ${topic} : ${parsed.error.issues[0]?.message ?? ''}`,
        );
        return;
      }
      console.log(JSON.stringify({ driver: topic.split('/')[2], ...parsed.data }));
    });
    if (!opts.follow) {
      await burst.done;
      await closeQuietly(bus);
    }
  });

await program.parseAsync(process.argv);
