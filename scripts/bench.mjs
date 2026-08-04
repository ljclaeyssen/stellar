#!/usr/bin/env node
// Banc d'essai : lance la maison SIMULÉE complète (simulateurs + drivers + core)
// pour l'explorer à la main — `pnpm bench` (Ctrl-C pour tout arrêter).
// Prérequis : mosquitto lancé (`docker compose -f infra/docker-compose.yml up -d`)
// et `pnpm build` fait. `node scripts/bench.mjs --help` détaille options et ports.
//
// Ce script n'est PAS un test : il ne vérifie rien, il donne une maison qui tourne
// (`stellar states --follow`, `stellar cmd …`, l'API tRPC sur 8850, le MCP sur 8851).
// Les vérifications, elles, vivent dans les specs — cf. docs/TESTING.md niveaux 1 à 3.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
// Imports explicites plutôt que globals : ce fichier est du Node ESM pur, hors de
// tout programme TypeScript, et eslint n'y suppose aucun environnement.
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MQTT_URL = process.env.STELLAR_MQTT_URL ?? 'mqtt://localhost:1883';

/** Secrets *de simulateur* : ils ne protègent rien et ne sortent jamais de cette machine. */
const HUE_APP_KEY = 'bench-hue-app-key';
const NETATMO_CLIENT_ID = 'bench-netatmo-client';
const NETATMO_CLIENT_SECRET = 'bench-netatmo-secret';
const NETATMO_REFRESH_TOKEN = 'bench-netatmo-refresh';
const RTE_CLIENT_ID = 'bench-rte-client';
const RTE_CLIENT_SECRET = 'bench-rte-secret';

/** Tout ce que le banc écrit vit ici (gitignoré) — jamais dans `config/`. */
const DATA_DIR = join(ROOT, 'data', 'bench');
const NETATMO_TOKEN_FILE = join(DATA_DIR, 'netatmo-token.json');

const SIM_HUE_URL = 'http://127.0.0.1:8842';
const SIM_NETATMO_URL = 'http://127.0.0.1:8843';
const SIM_TEMPO_URL = 'http://127.0.0.1:8844';

/**
 * Les services du banc, dans l'ordre de démarrage : simulateurs d'abord (les
 * drivers les attaquent dès leur première seconde), core en dernier (son miroir se
 * remplit tout seul par les retained, l'ordre ne lui importe pas — mais on veut
 * ses logs après ceux du parc).
 *
 * `group` sert au démarrage échelonné, `entry` est un `dist/main.js` : le banc
 * lance ce qui est *construit*, comme en production.
 */
const SERVICES = [
  {
    name: 'sim-hue',
    group: 'sim',
    entry: 'apps/simulators/hue/dist/main.js',
    env: { SIM_HUE_PORT: '8842', SIM_HUE_APP_KEY: HUE_APP_KEY, SIM_HUE_LINK_BUTTON: '1' },
  },
  {
    name: 'sim-netatmo',
    group: 'sim',
    entry: 'apps/simulators/netatmo/dist/main.js',
    env: {
      SIM_NETATMO_PORT: '8843',
      SIM_NETATMO_CLIENT_ID: NETATMO_CLIENT_ID,
      SIM_NETATMO_CLIENT_SECRET: NETATMO_CLIENT_SECRET,
      SIM_NETATMO_REFRESH_TOKEN: NETATMO_REFRESH_TOKEN,
    },
  },
  {
    name: 'sim-tempo',
    group: 'sim',
    entry: 'apps/simulators/tempo/dist/main.js',
    env: {
      SIM_TEMPO_PORT: '8844',
      SIM_TEMPO_CLIENT_ID: RTE_CLIENT_ID,
      SIM_TEMPO_CLIENT_SECRET: RTE_CLIENT_SECRET,
      // Bleu aujourd'hui, rouge demain : le cas intéressant de la régulation
      // (préchauffe nocturne avant un jour rouge, spec §10).
      SIM_TEMPO_TODAY: 'bleu',
      SIM_TEMPO_TOMORROW: 'rouge',
    },
  },
  {
    name: 'sim-z2m',
    group: 'sim',
    entry: 'apps/simulators/z2m/dist/main.js',
    env: { SIM_Z2M_MQTT_URL: MQTT_URL, SIM_Z2M_PERIOD_MS: '10000' },
  },
  {
    name: 'hue',
    group: 'driver',
    entry: 'apps/drivers/hue/dist/main.js',
    env: { HUE_BRIDGE_URL: SIM_HUE_URL, HUE_APP_KEY },
  },
  {
    name: 'netatmo',
    group: 'driver',
    entry: 'apps/drivers/netatmo/dist/main.js',
    env: {
      NETATMO_API_URL: SIM_NETATMO_URL,
      NETATMO_CLIENT_ID,
      NETATMO_CLIENT_SECRET,
      NETATMO_TOKEN_FILE,
      // Cadences de banc : on veut voir bouger, pas ménager une API distante.
      NETATMO_THERMOSTAT_INTERVAL_MS: '15000',
      NETATMO_STATION_INTERVAL_MS: '30000',
    },
  },
  {
    name: 'tempo',
    group: 'driver',
    entry: 'apps/drivers/tempo/dist/main.js',
    env: {
      RTE_API_URL: SIM_TEMPO_URL,
      RTE_CLIENT_ID,
      RTE_CLIENT_SECRET,
      TEMPO_FALLBACK_URL: SIM_TEMPO_URL,
      TEMPO_POLL_MS: '60000',
    },
  },
  {
    name: 'z2m',
    group: 'driver',
    entry: 'apps/drivers/z2m-normalizer/dist/main.js',
    env: {},
  },
  {
    name: 'fake-shutter',
    group: 'driver',
    entry: 'apps/drivers/fake-shutter/dist/main.js',
    // 500 ms par pas de 5 % : le volet met 10 s à faire sa course, on le voit
    // bouger dans `stellar states --follow` et dans Home Assistant.
    env: { FAKESHUTTER_SPEED_MS: '500' },
  },
  {
    name: 'core',
    group: 'core',
    entry: 'apps/core/dist/main.js',
    env: {
      CORE_API_PORT: '8850',
      CORE_MCP_PORT: '8851',
      CORE_DB_PATH: join(DATA_DIR, 'journal.db'),
      CORE_REGULATION_FILE: 'config/regulation.yaml',
    },
  },
];

/**
 * Midea n'a **pas** de simulateur de process : le choix ADR-005 est de simuler au
 * niveau du wrapper `packages/midea-protocol` (pas le protocole chiffré), donc
 * dans les tests, pas sur le bus. Un `midea-driver` lancé ici chercherait de vrais
 * dongles. On le dit plutôt que de le taire.
 */
const SKIPPED = [
  {
    name: 'midea',
    why: 'aucun process simulateur (ADR-005 : le faux Midea est au niveau du wrapper, dans les tests). Le lancer exigerait les 3 dongles réels + tokens sops.',
  },
];

const USAGE = `
Banc d'essai Stellar — la maison simulée complète, à explorer à la main.

  pnpm bench [options] [service...]
  node scripts/bench.mjs --help

Prérequis :
  1. mosquitto lancé   : docker compose -f infra/docker-compose.yml up -d
  2. paquets construits: pnpm build

Options :
  --help            cette aide (ne démarre rien, n'exige rien)
  --ha              allume le pont HA-discovery du core (retained sur homeassistant/#)
  service...        ne lancer que ces services (défaut : tous)

Services : ${SERVICES.map((service) => service.name).join(', ')}
Non lancé : ${SKIPPED.map((skip) => skip.name).join(', ')}

Ports    : sim-hue 8842 · sim-netatmo 8843 · sim-tempo 8844 · core API 8850 · core MCP 8851
Données  : ${relative(ROOT, DATA_DIR).replaceAll('\\', '/')}/ (journal SQLite, token du simulateur Netatmo)

Une fois lancé :
  pnpm --filter @stellar/cli exec stellar states --follow
  pnpm --filter @stellar/cli exec stellar cmd fake-shutter volet_salon set '{"position":30}'
  curl 'http://127.0.0.1:8850/getState?input={}'

Ctrl-C arrête tout le monde.
`;

// ───────────────────────────────── sortie ─────────────────────────────────

const WIDTH = Math.max(...SERVICES.map((service) => service.name.length));
const pad = (name) => name.padEnd(WIDTH);

const say = (name, line) => {
  process.stdout.write(`${pad(name)} | ${line}\n`);
};

/** Découpe un flux en lignes préfixées — les drivers loguent du JSON, une ligne par fait. */
function pipeLines(stream, name) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.length > 0) say(name, line);
  });
  stream.on('end', () => {
    if (rest.length > 0) say(name, rest);
  });
}

// ─────────────────────────────── prérequis ───────────────────────────────

/** Le broker est le seul prérequis externe : on le vérifie plutôt que d'échouer en boucle. */
function checkBroker(url) {
  const parsed = new URL(url);
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port || 1883);
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function checkBuilds(services) {
  return services.filter((service) => !existsSync(join(ROOT, service.entry)));
}

/**
 * Le driver Netatmo exige un refresh token sur disque (il le fait tourner à chaque
 * rafraîchissement — cf. sa config). On amorce celui du simulateur ; il est réécrit
 * ensuite par le driver lui-même.
 */
function prepareData() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    NETATMO_TOKEN_FILE,
    `${JSON.stringify({ refreshToken: NETATMO_REFRESH_TOKEN }, null, 2)}\n`,
  );
}

// ─────────────────────────────── démarrage ───────────────────────────────

const children = new Map();
let stopping = false;

function start(service, extraEnv) {
  const child = spawn(process.execPath, [service.entry], {
    cwd: ROOT,
    env: { ...process.env, STELLAR_MQTT_URL: MQTT_URL, ...service.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(service.name, child);
  pipeLines(child.stdout, service.name);
  pipeLines(child.stderr, service.name);
  child.on('exit', (code, signal) => {
    children.delete(service.name);
    if (stopping) return;
    // Un service qui tombe pendant l'exploration est une information, pas une
    // raison de tout arrêter : le reste de la maison continue de tourner.
    say(service.name, `⚠ process terminé (code ${code ?? 'null'}, signal ${signal ?? 'aucun'})`);
  });
  return child;
}

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function stopAll(signal) {
  if (stopping) return;
  stopping = true;
  say('bench', `arrêt (${signal}) — ${children.size} process`);
  for (const child of children.values()) child.kill('SIGTERM');
  // Filet : ce qui ne rend pas la main en 5 s est tué net.
  const forced = setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(0);
  }, 5_000);
  forced.unref();
  const poll = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(poll);
    clearTimeout(forced);
    process.exit(0);
  }, 100);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const haBridge = args.includes('--ha');
  const wanted = args.filter((arg) => !arg.startsWith('-'));
  const unknown = wanted.filter((name) => !SERVICES.some((service) => service.name === name));
  if (unknown.length > 0) {
    process.stderr.write(`service inconnu: ${unknown.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  const services =
    wanted.length === 0 ? SERVICES : SERVICES.filter((service) => wanted.includes(service.name));

  if (!(await checkBroker(MQTT_URL))) {
    process.stderr.write(
      `broker MQTT injoignable sur ${MQTT_URL}\n` +
        '  → docker compose -f infra/docker-compose.yml up -d\n' +
        '  (ou STELLAR_MQTT_URL=mqtt://<hôte>:1883 pour viser un autre broker)\n',
    );
    process.exit(1);
  }

  const missing = checkBuilds(services);
  if (missing.length > 0) {
    process.stderr.write(
      `paquets non construits : ${missing.map((service) => service.name).join(', ')}\n` +
        '  → pnpm build\n',
    );
    process.exit(1);
  }

  prepareData();

  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));

  say('bench', `broker ${MQTT_URL} · ${services.length} services · Ctrl-C pour tout arrêter`);
  for (const skip of SKIPPED) say('bench', `↷ ${skip.name} non lancé : ${skip.why}`);

  // Démarrage échelonné : les simulateurs doivent écouter avant que leurs drivers
  // ne frappent à la porte (sans quoi on lit une salve d'erreurs de connexion
  // parfaitement inutile), et le core arrive quand le parc parle déjà.
  for (const group of ['sim', 'driver', 'core']) {
    const batch = services.filter((service) => service.group === group);
    if (batch.length === 0) continue;
    for (const service of batch) {
      start(service, group === 'core' && haBridge ? { CORE_HA_BRIDGE: '1' } : {});
    }
    await wait(group === 'core' ? 0 : 1_000);
  }

  if (haBridge) say('bench', 'pont HA-discovery allumé (retained sur homeassistant/#)');
}

await main();
