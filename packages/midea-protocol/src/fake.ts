import { MideaUnreachableError, type MideaApplianceLike } from './appliance.js';
import { loadStatusFixture, type FixtureName } from './fixtures.js';
import {
  MIDEA_FAN_SPEED_BY_NAME,
  MIDEA_MODE_BY_VALUE,
  MideaStatus,
  MideaStatusPatch,
  type MideaStatusPatch as MideaStatusPatchType,
} from './status.js';

export interface FakeApplianceOptions {
  id?: string;
  /** Fixture d'amorçage (défaut `status-heat`). */
  fixture?: FixtureName;
  /** Écrase la fixture champ par champ. */
  status?: Partial<MideaStatus>;
  /** Latence simulée de chaque appel, en ms (défaut 0). */
  latencyMs?: number;
}

export interface FakeAppliance extends MideaApplianceLike {
  /** Copie de l'état courant — lecture directe dans les assertions de test. */
  readonly status: MideaStatus;
  readonly calls: {
    readonly connect: number;
    readonly getStatus: number;
    readonly setStatus: number;
  };
  /** L'unité mesure une nouvelle T° intérieure (le polling doit la voir remonter). */
  setIndoor(temp: number): void;
  /** Les `n` prochains appels échouent en « unreachable », puis tout repart. */
  failNext(n: number): void;
  /** Panne franche : tout échoue tant que ce n'est pas remis à `false`. */
  setUnreachable(unreachable: boolean): void;
  setLatency(ms: number): void;
}

const MODE_VALUE_BY_NAME = Object.fromEntries(
  Object.entries(MIDEA_MODE_BY_VALUE).map(([value, name]) => [name, Number(value)]),
) as Record<string, number>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Faux appareil Midea — **simulateur de niveau 2 de la phase P4** (ADR-010 :
 * on simule à la couture du wrapper, jamais le protocole chiffré ; c'est le
 * `sim-midea` annoncé par docs/TESTING.md §2, ici sous forme de fabrique plutôt
 * que de process, la couture n'ayant pas de surface réseau à imiter).
 *
 * Exporté **publiquement** (`@stellar/midea-protocol/testing`) : le driver le
 * consomme dans ses tests, et un humain peut s'en servir pour faire tourner le
 * driver sans matériel avant l'atelier P4.0.
 */
export function createFakeAppliance(options: FakeApplianceOptions = {}): FakeAppliance {
  const id = options.id ?? 'fake-appliance';
  let status: MideaStatus = MideaStatus.parse({
    ...loadStatusFixture(options.fixture),
    ...options.status,
  });
  let latencyMs = options.latencyMs ?? 0;
  let unreachable = false;
  let failures = 0;
  const calls = { connect: 0, getStatus: 0, setStatus: 0 };

  /** Une panne se manifeste *après* la latence : c'est ce que fait un timeout réel. */
  const gate = async (label: string): Promise<void> => {
    if (latencyMs > 0) await sleep(latencyMs);
    if (unreachable) {
      throw new MideaUnreachableError(`${label}: unité injoignable (fake)`, id);
    }
    if (failures > 0) {
      failures -= 1;
      throw new MideaUnreachableError(`${label}: échec ponctuel simulé (fake)`, id);
    }
  };

  const apply = (patch: MideaStatusPatchType): void => {
    const next: Record<string, unknown> = { ...status };
    if (patch.powerOn !== undefined) next['powerOn'] = patch.powerOn;
    if (patch.mode !== undefined) next['mode'] = MODE_VALUE_BY_NAME[patch.mode];
    if (patch.temperatureSetpoint !== undefined) {
      next['temperatureSetpoint'] = patch.temperatureSetpoint;
    }
    if (patch.fanSpeed !== undefined) {
      next['fanSpeed'] =
        typeof patch.fanSpeed === 'number'
          ? patch.fanSpeed
          : MIDEA_FAN_SPEED_BY_NAME[patch.fanSpeed];
    }
    status = MideaStatus.parse(next);
  };

  return {
    id,
    get status() {
      return { ...status };
    },
    calls,

    async connect() {
      calls.connect += 1;
      await gate('connect');
    },

    async getStatus() {
      calls.getStatus += 1;
      await gate('getStatus');
      return { ...status };
    },

    async setStatus(patch) {
      calls.setStatus += 1;
      // Validation *avant* la porte : un patch invalide est une erreur d'appelant,
      // pas une panne — il doit être refusé même unité injoignable.
      const validated = MideaStatusPatch.parse(patch);
      await gate('setStatus');
      apply(validated);
      return { ...status };
    },

    disconnect() {
      /* rien à libérer : le fake n'ouvre rien */
    },

    setIndoor(temp) {
      status = MideaStatus.parse({ ...status, indoorTemperature: temp });
    },
    failNext(n) {
      failures = n;
    },
    setUnreachable(value) {
      unreachable = value;
    },
    setLatency(ms) {
      latencyMs = ms;
    },
  };
}
