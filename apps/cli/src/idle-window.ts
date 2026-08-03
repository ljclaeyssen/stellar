export interface IdleWindow {
  /** À appeler à chaque message reçu : repousse la fin de la fenêtre. */
  bump: () => void;
  /** Résolue une seule fois, au premier des deux : silence de `idleMs` ou borne `maxMs`. */
  done: Promise<void>;
}

/**
 * Fenêtre d'inactivité : rend la main après `idleMs` sans nouveau message, et au
 * plus tard au bout de `maxMs`. Remplace un sleep fixe, qui était à la fois trop
 * court (rafale de retained tronquée sur un gros parc) et trop long (1,5 s d'attente
 * systématique pour trois entités).
 */
export function idleWindow(idleMs = 400, maxMs = 3_000): IdleWindow {
  let idleTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(idleTimer);
    settle();
  };

  const bump = (): void => {
    if (settled) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, idleMs);
  };

  // Borne dure : un flux continu ne doit pas retenir le CLI indéfiniment.
  setTimeout(finish, maxMs).unref();
  bump();
  return { bump, done };
}
