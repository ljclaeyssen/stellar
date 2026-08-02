import { createBroker } from 'aedes';
import { createServer, type Server } from 'node:net';

/** Broker en mémoire pour les tests — même helper que packages/bus. */
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
  return {
    port: address.port,
    url: `mqtt://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => aedes.close(resolve));
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
