import type { MideaStatus, MideaStatusPatch } from './status.js';

/**
 * Couture de transport d'une unité Midea (ADR-010 niveau 1). Le driver ne connaît
 * que ça : ni la lib, ni le protocole chiffré, ni le socket.
 *
 * **Pas d'événements.** Le README de node-mideahvac documente `connected` /
 * `disconnected`, mais `grep emit( lib/sk103.js` ne remonte que `initialized` :
 * ces deux événements sont émis par `lib/serialbridge.js` seulement. En sk103 la
 * connexion TCP est ouverte paresseusement puis détruite dès que la file de
 * commandes se vide (`lib/sk103.js:_processQueue`), donc il n'y a même pas de
 * session dont on pourrait signaler la perte.
 *
 * Conséquence assumée : **la détection d'équipement muet passe uniquement par les
 * rejets de `getStatus`** (timeout, échec d'authentification, socket refusé).
 * C'est suffisant — un SK103 pollé toutes les 45 s dit son silence en 45 s, et la
 * spec §9 ne demande qu'un seuil de 5 min.
 */
export interface MideaApplianceLike {
  /** Identifiant de l'unité chez Midea — sert au diagnostic, jamais au routage. */
  readonly id: string;
  /**
   * Amorçage : établit le premier échange et **amorce l'état interne**.
   * Indispensable avant tout `setStatus` : `lib/ac.js` construit sa trame à
   * partir de `this.status`, rempli uniquement par un `getStatus` préalable.
   */
  connect(): Promise<void>;
  getStatus(): Promise<MideaStatus>;
  /** Rend l'état **après** application — sert de resynchronisation immédiate. */
  setStatus(patch: MideaStatusPatch): Promise<MideaStatus>;
  /** Best effort : libère ce qui peut l'être. Jamais de rejet. */
  disconnect(): void;
}

/**
 * L'unité n'a pas répondu. Distinguée d'une erreur de programmation ou de
 * validation : c'est elle, et elle seule, qui autorise le driver à marquer ses
 * entités `stale` (ADR-009) et à refuser une commande plutôt que d'accuser un
 * `ok` qu'il ne peut pas tenir.
 */
export class MideaUnreachableError extends Error {
  override readonly name = 'MideaUnreachableError';
  constructor(
    message: string,
    readonly applianceId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** L'unité a répondu, mais a refusé la commande (valeur hors bornes, mode incompatible…). */
export class MideaRejectedError extends Error {
  override readonly name = 'MideaRejectedError';
  constructor(
    message: string,
    readonly applianceId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export const isUnreachable = (err: unknown): err is MideaUnreachableError =>
  err instanceof MideaUnreachableError;
