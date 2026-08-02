#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Command as Cli } from 'commander';
import { createBus, type Bus } from '@stellar/bus';
import { Selector, healthTopic, type Health } from '@stellar/contracts';

const program = new Cli();
program
  .name('stellar')
  .description('Inspection du bus Stellar : états, commandes, santé des drivers')
  .option('-u, --url <url>', 'URL du broker MQTT', 'mqtt://localhost:1883');

async function connect(): Promise<Bus> {
  const { url } = program.opts<{ url: string }>();
  return createBus({ url, clientId: `cli-${process.pid}`, driver: 'cli' });
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
    await bus.onState(selector, (entity) => {
      console.log(JSON.stringify(entity));
    });
    if (!opts.follow) {
      // le temps de recevoir les retained
      await new Promise((r) => setTimeout(r, 1_500));
      await bus.close();
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
      const bus = await connect();
      const ack = await bus.sendCommand(
        {
          id: randomUUID(),
          target: entityId,
          action,
          params: JSON.parse(params) as Record<string, unknown>,
          issuedBy: 'cli',
          ts: new Date().toISOString(),
        },
        { driver, timeoutMs: Number(opts.timeout) },
      );
      console.log(JSON.stringify(ack));
      await bus.close();
      process.exitCode = ack.status === 'ok' ? 0 : 1;
    },
  );

program
  .command('health')
  .description('affiche le statut online/offline des drivers')
  .option('-f, --follow', 'rester abonné', false)
  .action(async (opts: { follow: boolean }) => {
    const bus = await connect();
    await bus.client.subscribeAsync(healthTopic('+'), { qos: 1 });
    bus.client.on('message', (topic, payload) => {
      try {
        const health = JSON.parse(payload.toString()) as Health;
        console.log(JSON.stringify({ driver: topic.split('/')[2], ...health }));
      } catch {
        console.error(`payload illisible sur ${topic}`);
      }
    });
    if (!opts.follow) {
      await new Promise((r) => setTimeout(r, 1_500));
      await bus.close();
    }
  });

await program.parseAsync(process.argv);
