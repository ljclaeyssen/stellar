import { createBroker } from 'aedes';
import { createServer, type Server } from 'node:net';

/**
 * Outils de test partagés — consommés **en source** depuis les `*.spec.ts`
 * (pas de build : l'export `.` pointe directement sur `src/index.ts`).
 *
 * Les attentes se font avec `vi.waitFor` / `expect.poll` de vitest : pas de
 * helper `waitFor` maison ici.
 */

/**
 * Broker MQTT en mémoire pour les tests d'intégration (spec §15).
 * aedes ne supporte MQTT 5 que partiellement → les tests utilisent
 * protocolVersion 4 ; le fallback `home/ack/<commandId>` couvre le req/resp.
 */
export interface TestBroker {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startTestBroker(): Promise<TestBroker> {
  const aedes = createBroker();
  const server: Server = createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const port = address.port;
  return {
    port,
    url: `mqtt://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => aedes.close(resolve));
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
