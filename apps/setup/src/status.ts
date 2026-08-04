import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

/**
 * Le bandeau de statut de l'IHM : trois voyants, aucune promesse.
 *
 * C'est du **best-effort volontairement bête** : une connexion TCP qui aboutit ou
 * non, un fichier qui existe ou non. Pas de handshake MQTT, pas de requête tRPC,
 * pas de dépendance. Le voyant dit « le port répond », pas « le service va bien » —
 * la preuve de vie sérieuse, c'est `stellar health`, et c'est l'assistant qui la
 * fait faire (étape 8 de la procédure). Ce bandeau ne sert qu'à orienter la
 * conversation : « le broker ne répond pas, on le lance ? ».
 *
 * Le budget est serré (300 ms) parce que l'IHM interroge toutes les 5 secondes :
 * un check lent rendrait la page collante pour un ornement.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 300;
export const DEFAULT_BROKER_PORT = 1883;
export const DEFAULT_CORE_API_PORT = 8850;

export interface SetupStatus {
  /** Un TCP est accepté sur le port du broker. */
  broker: boolean;
  /** Un TCP est accepté sur le port de l'API du core. */
  coreApi: boolean;
  /** `.env` existe à la racine du dépôt. */
  env: boolean;
  ports: { broker: number; coreApi: number };
}

export interface StatusDeps {
  repoRoot: string;
  brokerPort?: number;
  coreApiPort?: number;
  host?: string;
  timeoutMs?: number;
}

/** Vrai si un TCP s'établit dans le budget. Ne rejette jamais. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function probeStatus(deps: StatusDeps): Promise<SetupStatus> {
  const host = deps.host ?? '127.0.0.1';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const ports = {
    broker: deps.brokerPort ?? DEFAULT_BROKER_PORT,
    coreApi: deps.coreApiPort ?? DEFAULT_CORE_API_PORT,
  };
  const [broker, coreApi] = await Promise.all([
    probeTcp(host, ports.broker, timeoutMs),
    probeTcp(host, ports.coreApi, timeoutMs),
  ]);
  return { broker, coreApi, env: existsSync(join(deps.repoRoot, '.env')), ports };
}
