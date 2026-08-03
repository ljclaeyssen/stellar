import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idleWindow } from './idle-window.js';

/** Sonde de résolution : évite d'`await` une promesse qui ne se résoudra jamais. */
const track = (promise: Promise<void>): { resolved: () => boolean; count: () => number } => {
  let count = 0;
  void promise.then(() => {
    count += 1;
  });
  return { resolved: () => count > 0, count: () => count };
};

describe('idleWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('se ferme après idleMs de silence', async () => {
    const probe = track(idleWindow(100, 10_000).done);

    await vi.advanceTimersByTimeAsync(99);
    expect(probe.resolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.resolved()).toBe(true);
  });

  it('bump repousse la fin de la fenêtre', async () => {
    const window = idleWindow(100, 10_000);
    const probe = track(window.done);

    // Trois messages espacés de 80 ms : la fenêtre ne doit jamais se fermer.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(80);
      expect(probe.resolved()).toBe(false);
      window.bump();
    }

    await vi.advanceTimersByTimeAsync(99);
    expect(probe.resolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.resolved()).toBe(true);
  });

  it('maxMs borne un flux continu', async () => {
    const window = idleWindow(100, 250);
    const probe = track(window.done);

    // Flux ininterrompu : sans la borne dure, `bump` repousserait indéfiniment.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(50);
      window.bump();
    }
    expect(probe.resolved()).toBe(false); // t = 200 ms, jamais 100 ms de silence

    await vi.advanceTimersByTimeAsync(50);
    expect(probe.resolved()).toBe(true); // t = 250 ms = maxMs
  });

  it('ne se ferme qu’une fois et n’arme plus rien après coup', async () => {
    const window = idleWindow(100, 250);
    const probe = track(window.done);

    await vi.advanceTimersByTimeAsync(100);
    expect(probe.count()).toBe(1);

    // Un bump tardif ne doit ni relancer de timer ni re-résoudre.
    const armed = vi.getTimerCount();
    window.bump();
    expect(vi.getTimerCount()).toBe(armed);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe.count()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
