/**
 * Typage minimal de la lib `node-mideahvac` (0.3.3, CommonJS, sans types).
 *
 * **Signatures relevées dans le code installé** (`node_modules/node-mideahvac`) —
 * pas de mémoire, pas de supposition :
 *
 * - `lib/index.js` : `exports.createAppliance = (options = {}) => …`, aiguillage
 *   sur `options.communicationMethod` (`'sk103'` | `'serialbridge'`).
 * - `lib/sk103.js` : `class extends AC`, constructeur exigeant
 *   `host`, `id`, `key`, `token` (sinon `throw`). Port TCP **6444** en dur.
 *   `async initialize()` → `{ status, capabilities }` puis `emit('initialized')`.
 * - `lib/ac.js` : `class extends EventEmitter`, `getStatus(retry = 0): Promise`,
 *   `setStatus(properties = {}, retry = 0): Promise`, `getCapabilities(retry = 0)`,
 *   `getPowerUsage(retry = 0)`. Émet `status-update` sur changement de propriété.
 * - **Aucune méthode publique de connexion/déconnexion** : `_connect()` est privé,
 *   appelé paresseusement par `_processQueue()`, qui fait `_connection.destroy()`
 *   dès que la file de commandes se vide. La connexion TCP est donc *par rafale de
 *   commandes*, pas persistante.
 * - Les événements `connected` / `disconnected` documentés dans le README sont
 *   émis par `lib/serialbridge.js` **uniquement** — `grep emit( lib/sk103.js` ne
 *   remonte que `initialized`. En sk103, la détection de panne passe donc
 *   exclusivement par les rejets de `getStatus` (cf. `MideaApplianceLike`).
 * - Timeouts internes : 5 s à la connexion, 2 s d'attente de réponse par commande
 *   (`lib/sk103.js`), d'où le filet à 8 s côté wrapper.
 * - `lib/reporter.js` : `mode`, `fanSpeed`, `cosySleep`, `pmv`, `statusCode`,
 *   `temperatureUnit`, `timerMode` sont rapportés en `{ value, description }` —
 *   c'est ce que `normalizeStatus` aplatit.
 */
declare module 'node-mideahvac' {
  import type { EventEmitter } from 'node:events';

  export interface Sk103Options {
    communicationMethod: 'sk103';
    host: string;
    id: string;
    key: string;
    token: string;
  }

  export interface SerialBridgeOptions {
    communicationMethod: 'serialbridge';
    host: string;
    port?: number;
  }

  export interface Appliance extends EventEmitter {
    readonly status: Record<string, unknown>;
    readonly capabilities: Record<string, unknown>;
    getStatus(retry?: number): Promise<Record<string, unknown>>;
    setStatus(
      properties: Record<string, unknown>,
      retry?: number,
    ): Promise<Record<string, unknown>>;
    getCapabilities(retry?: number): Promise<Record<string, unknown>>;
    initialize(): Promise<{ status: unknown; capabilities: unknown }>;
  }

  export function createAppliance(options: Sk103Options | SerialBridgeOptions): Appliance;
}
