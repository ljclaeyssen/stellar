import { createAppliance, type Appliance } from 'node-mideahvac';
import { MideaRejectedError, MideaUnreachableError, type MideaApplianceLike } from './appliance.js';
import { MideaStatusPatch, normalizeStatus, type MideaStatus } from './status.js';

export interface Sk103Params {
  /** IP fixe du dongle (réserver un bail DHCP — spec §3 réseau). */
  host: string;
  /** Trio obtenu à l'atelier P4.0 (`midea-discover`), archivé chiffré sops. */
  id: string;
  token: string;
  key: string;
  /**
   * Filet au-dessus des timeouts internes de la lib (5 s connexion, 2 s réponse
   * par commande, `lib/sk103.js`) : si la lib elle-même se perd, on rend la main.
   */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;

/** Erreurs de `lib/errors.js` qui signent un équipement injoignable, pas un refus. */
const UNREACHABLE_ERROR_NAMES = new Set([
  'TimeoutError',
  'AuthenticationError',
  'AuthorizationError',
]);

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);

/**
 * `lib/sk103.js` échoue de plusieurs façons : `TimeoutError` typée, mais aussi
 * chaînes brutes (`'Failed to authenticate'`, `'Failed to connect'`) passées au
 * handler de commande, et erreurs de socket Node (`ECONNREFUSED`, `EHOSTUNREACH`).
 * Tout ça, c'est « l'unité ne répond pas ».
 */
const looksUnreachable = (err: unknown): boolean => {
  if (err instanceof Error && UNREACHABLE_ERROR_NAMES.has(err.name)) return true;
  const message = messageOf(err);
  return /timeout|failed to (connect|authenticate)|ECONN|EHOST|ENET|ETIMEDOUT|socket/i.test(
    message,
  );
};

/**
 * Course contre la montre — la lib ne garantit pas de rendre la main : quand un
 * `_processQueue` se perd (file pleine, socket zombie), la promesse ne se règle
 * jamais et le driver resterait bloqué sur un cycle de polling ad vitam.
 */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  applianceId: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MideaUnreachableError(
                `${label}: pas de réponse en ${String(timeoutMs)} ms`,
                applianceId,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wrapper typé de node-mideahvac en mode sk103 (ADR-005 : on ne réimplémente pas
 * le protocole).
 *
 * **Aucun retry interne** — c'est délibéré, et c'est la contrainte n°1 de cette
 * phase : le SK103 décroche du WiFi et exige un power-cycle quand on le sollicite
 * trop (README de la lib, spec §9). La lib accepte un paramètre `retry` ; on le
 * laisse à 0 et c'est le driver, seul, qui cadence (polling doux 30–60 s).
 */
export function createSk103Appliance(params: Sk103Params): MideaApplianceLike {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const appliance: Appliance = createAppliance({
    communicationMethod: 'sk103',
    host: params.host,
    id: params.id,
    key: params.key,
    token: params.token,
  });

  const call = async (
    label: string,
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<MideaStatus> => {
    let raw: Record<string, unknown>;
    try {
      raw = await withTimeout(operation(), timeoutMs, label, params.id);
    } catch (err) {
      if (err instanceof MideaUnreachableError) throw err;
      if (looksUnreachable(err)) {
        throw new MideaUnreachableError(`${label}: ${messageOf(err)}`, params.id, err);
      }
      throw new MideaRejectedError(`${label}: ${messageOf(err)}`, params.id, err);
    }
    // Une réponse illisible n'est pas un équipement muet : c'est un firmware qui
    // ne dit pas ce qu'on croit. On la remonte telle quelle, le driver la loggue.
    return normalizeStatus(raw);
  };

  return {
    id: params.id,

    /**
     * Un simple `getStatus`, pas `initialize()`. Deux raisons relevées dans la lib :
     * `initialize()` enchaîne `getCapabilities` + `getStatus` (deux allers-retours
     * sur un dongle qu'on veut ménager, pour une commande 0xB5 que le README
     * lui-même dit non supportée par tous les modèles), et son `catch` fait
     * `throw logger.error(...)` — winston rend le logger, donc elle rejette avec
     * un objet logger au lieu d'une Error.
     *
     * Le `getStatus` amorce par ailleurs `this.status` dans `lib/ac.js`, ce dont
     * `setStatus` a besoin pour construire sa trame.
     */
    async connect(): Promise<void> {
      await call('connect', () => appliance.getStatus());
    },

    getStatus: () => call('getStatus', () => appliance.getStatus()),

    setStatus: (patch) => {
      const validated = MideaStatusPatch.parse(patch);
      return call('setStatus', () => appliance.setStatus(validated));
    },

    /**
     * Rien à fermer : `lib/sk103.js:_processQueue` détruit la connexion TCP dès
     * que la file de commandes se vide, et la classe n'expose ni `close` ni
     * `destroy` (vérifié à l'exécution sur l'instance). On coupe seulement les
     * écouteurs pour ne pas retenir le driver à l'arrêt.
     */
    disconnect(): void {
      appliance.removeAllListeners();
    },
  };
}
