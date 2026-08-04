import { healthTopic, stateTopic, type Entity, type Kind } from '@stellar/contracts';

/**
 * Traduction `Entity` → **config MQTT discovery de Home Assistant** (P8, spec §10).
 *
 * Ce module est pur : une entité entre, une config sort. Aucune I/O, aucun état —
 * c'est ce qui permet de le tester à la table et de le relire comme une table de
 * correspondance.
 *
 * Trois partis pris, tous dictés par l'interdit §4 n°5 (« aucune logique dans HA ») :
 *
 * 1. **HA ne stocke rien.** Chaque config pointe sur NOS topics `home/state/…`
 *    retained : l'état de la maison reste sur le bus, HA n'en est qu'un lecteur.
 *    Un HA détruit et recréé retrouve tout en se réabonnant.
 * 2. **Aucune transformation métier côté HA.** Les `value_template` ne font que
 *    lire un champ de notre contrat (`value.on`, `value.targetTemp`…) ou traduire
 *    un vocabulaire (notre `mode:'fan'` ↔ le `fan_only` de HA). Rien qui décide.
 * 3. **Les payloads de commande sont du JSON.** HA laisse choisir `payload_on` /
 *    `payload_off` et fournit des `*_command_template` : on en profite pour que
 *    tout ce qui transite sous `home/` reste du JSON, comme le reste du bus. Ce
 *    n'est pas cosmétique : le dispatcher de `packages/bus` `JSON.parse` tout
 *    message `home/…`, et un `ON` brut y produirait un « payload illisible » à
 *    chaque commande vocale.
 *
 * Les kinds réservés (`button`, `doorbell`) et `lock` ne sont **jamais** exposés :
 * la voix ne pilote pas la sécurité (spec §4 n°1), et un contrat de commande qui
 * n'existe pas encore ne se publie pas « au cas où ». `cover`, lui, a reçu son
 * contrat en P9 (`CoverValue`) : un volet est un actionneur de confort, il a sa
 * place dans HA au même titre qu'une lampe.
 */

/** Préfixe de découverte par défaut de HA (`homeassistant/<component>/<objectId>/config`). */
export const HA_DISCOVERY_DEFAULT_PREFIX = 'homeassistant';

/** Racine des topics de commande que HA nous adresse — c'est NOUS qui la choisissons. */
export const HA_COMMAND_ROOT = 'home/ha/cmd';
/** Filtre d'abonnement du pont. */
export const HA_COMMAND_FILTER = `${HA_COMMAND_ROOT}/#`;

/**
 * Sous-champ commandable d'une entité. Le topic principal (sans suffixe) porte
 * l'allumage ; les autres réglages ont chacun leur topic, comme HA l'attend
 * (`brightness_command_topic`, `temperature_command_topic`…).
 */
export const HA_FIELD = {
  brightness: 'brightness',
  mode: 'mode',
  temperature: 'temperature',
  position: 'position',
} as const;

/** Payloads booléens : du JSON valide, cf. parti pris n°3. */
export const HA_PAYLOAD_ON = 'true';
export const HA_PAYLOAD_OFF = 'false';

/** Notre `brightness` est en % (contrat `LightValue`) — on le dit à HA plutôt que de convertir. */
export const HA_BRIGHTNESS_SCALE = 100;

/** Bornes de consigne offertes à la voix (le driver reste libre de refuser). */
export const HA_CLIMATE_MIN_TEMP = 8;
export const HA_CLIMATE_MAX_TEMP = 30;
export const HA_CLIMATE_TEMP_STEP = 0.5;

/** Entités sans pièce (index Linky, Tempo, météo) : un « device » de la maison. */
export const HA_DEFAULT_ROOM = 'maison';

const MANUFACTURER = 'Stellar';
const MODEL = 'bus MQTT';

/** Composants HA que le pont sait produire. */
export type HaComponent = 'light' | 'switch' | 'sensor' | 'binary_sensor' | 'climate' | 'cover';

/** Bornes de course d'un `cover` HA — notre `CoverValue.position` est déjà en % (0 fermé). */
export const HA_COVER_POSITION_CLOSED = 0;
export const HA_COVER_POSITION_OPEN = 100;

/** Verbes d'un `cover` HA, en JSON comme tout ce qui transite sous `home/` (parti pris n°3). */
export const HA_COVER_PAYLOAD = {
  open: '"open"',
  close: '"close"',
  stop: '"stop"',
} as const;

export interface HaDiscovery {
  component: HaComponent;
  /** `stellar_<entityId>` — sert d'`object_id` de topic ET d'`unique_id`. */
  objectId: string;
  /** `<prefix>/<component>/<objectId>/config` */
  topic: string;
  config: Record<string, unknown>;
}

/** `stellar_<entityId>` : préfixé pour ne jamais entrer en collision avec une autre intégration. */
export const haObjectId = (entityId: string): string => `stellar_${entityId}`;

export function haCommandTopic(entityId: string, field?: string): string {
  return field === undefined
    ? `${HA_COMMAND_ROOT}/${entityId}`
    : `${HA_COMMAND_ROOT}/${entityId}/${field}`;
}

/**
 * Nom lisible : l'`entityId` est déjà `<type>_<room>[_<detail>]` (spec §6), les
 * underscores en moins il se prononce. Les alias vocaux fins (« la lampe du
 * canapé ») se règlent dans l'UI de HA — c'est du nommage, pas de la logique.
 */
const humanize = (entityId: string): string => entityId.replaceAll('_', ' ');

/**
 * `stale` et `room` en attributs plutôt qu'en entités séparées : la fraîcheur est
 * une propriété de la mesure, pas une mesure. Un capteur figé reste visible dans
 * HA — c'est le core qui décide quoi en faire (spec §10, fallbacks sûrs).
 */
const ATTRIBUTES_TEMPLATE =
  "{{ {'stale': value_json.stale | default(false), 'room': value_json.room | default('')} | tojson }}";

/** Rend le `payload_on`/`payload_off` attendu à partir d'une expression Jinja booléenne. */
const boolTemplate = (expression: string): string =>
  `{{ '${HA_PAYLOAD_ON}' if ${expression} else '${HA_PAYLOAD_OFF}' }}`;

interface MappingContext {
  entity: Entity;
  /** `home/state/<driver>/<id>` — la seule source d'état, jamais dupliquée. */
  state: string;
  /** Champs communs : identité, disponibilité, attributs, device. */
  base: Record<string, unknown>;
  /** Topic de commande, éventuellement suffixé d'un champ. */
  cmd: (field?: string) => string;
}

interface HaEntityConfig {
  component: HaComponent;
  config: Record<string, unknown>;
}

type KindMapper = (ctx: MappingContext) => HaEntityConfig;

const sensor = (ctx: MappingContext, extra: Record<string, unknown>): HaEntityConfig => ({
  component: 'sensor',
  config: { ...ctx.base, state_topic: ctx.state, ...extra },
});

/**
 * Table de correspondance `kind` → composant HA. `null` = jamais exposé.
 *
 * `satisfies Record<Kind, …>` garantit l'exhaustivité : ajouter un `kind` aux
 * contrats casse la compilation ici tant qu'on n'a pas dit ce que HA doit en voir
 * (y compris « rien »).
 */
const mappers = {
  light: (ctx) => ({
    component: 'light',
    config: {
      ...ctx.base,
      state_topic: ctx.state,
      state_value_template: boolTemplate('value_json.value.on'),
      command_topic: ctx.cmd(),
      payload_on: HA_PAYLOAD_ON,
      payload_off: HA_PAYLOAD_OFF,
      // La luminosité est déclarée même quand l'état courant ne la porte pas :
      // une config qui dépendrait de la présence d'un champ optionnel se
      // republierait à chaque fois qu'un driver l'omet — un retained qui bat est
      // pire qu'un curseur inutile sur une ampoule tout-ou-rien.
      brightness_state_topic: ctx.state,
      brightness_value_template: '{{ value_json.value.brightness | default(0) | round(0) }}',
      brightness_command_topic: ctx.cmd(HA_FIELD.brightness),
      brightness_scale: HA_BRIGHTNESS_SCALE,
    },
  }),

  plug: (ctx) => ({
    component: 'switch',
    config: {
      ...ctx.base,
      state_topic: ctx.state,
      value_template: boolTemplate('value_json.value.on'),
      state_on: HA_PAYLOAD_ON,
      state_off: HA_PAYLOAD_OFF,
      command_topic: ctx.cmd(),
      payload_on: HA_PAYLOAD_ON,
      payload_off: HA_PAYLOAD_OFF,
      device_class: 'outlet',
    },
  }),

  temperature: (ctx) =>
    sensor(ctx, {
      device_class: 'temperature',
      unit_of_measurement: ctx.entity.unit ?? '°C',
      state_class: 'measurement',
      value_template: '{{ value_json.value }}',
    }),

  humidity: (ctx) =>
    sensor(ctx, {
      device_class: 'humidity',
      unit_of_measurement: ctx.entity.unit ?? '%',
      state_class: 'measurement',
      value_template: '{{ value_json.value }}',
    }),

  // `apparent_power` et non `power` : notre `PowerValue.va` est en volt-ampères
  // (ZLinky), et HA n'accepte les VA que sous cette device_class — un `power` en
  // VA fait rejeter l'entité au démarrage de HA.
  power: (ctx) =>
    sensor(ctx, {
      device_class: 'apparent_power',
      unit_of_measurement: ctx.entity.unit ?? 'VA',
      state_class: 'measurement',
      value_template: '{{ value_json.value.va }}',
    }),

  presence: (ctx) => ({
    component: 'binary_sensor',
    config: {
      ...ctx.base,
      state_topic: ctx.state,
      value_template: boolTemplate('value_json.value'),
      payload_on: HA_PAYLOAD_ON,
      payload_off: HA_PAYLOAD_OFF,
      device_class: 'occupancy',
    },
  }),

  climate: (ctx) => ({
    component: 'climate',
    config: {
      ...ctx.base,
      // `power:false` devient le mode `off` de HA, et notre `fan` son `fan_only` :
      // pure traduction de vocabulaire, dans les deux sens (cf. commands.ts).
      modes: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'],
      mode_state_topic: ctx.state,
      mode_state_template:
        '{% if not value_json.value.power %}off' +
        "{% elif value_json.value.mode == 'fan' %}fan_only" +
        '{% else %}{{ value_json.value.mode }}{% endif %}',
      mode_command_topic: ctx.cmd(HA_FIELD.mode),
      // Rend `"heat"` — une chaîne JSON, cf. parti pris n°3.
      mode_command_template: '"{{ value }}"',
      temperature_state_topic: ctx.state,
      temperature_state_template: '{{ value_json.value.targetTemp }}',
      temperature_command_topic: ctx.cmd(HA_FIELD.temperature),
      current_temperature_topic: ctx.state,
      current_temperature_template: '{{ value_json.value.indoorTemp | default(none) }}',
      temperature_unit: 'C',
      min_temp: HA_CLIMATE_MIN_TEMP,
      max_temp: HA_CLIMATE_MAX_TEMP,
      temp_step: HA_CLIMATE_TEMP_STEP,
    },
  }),

  // MQTT n'a pas de `media_player` natif côté HA : un capteur d'état (éteint /
  // application en cours) suffit à « qu'est-ce qui tourne au salon ? ». Le
  // pilotage de la TV passe par l'agent (MCP), pas par une entité HA bancale.
  media: (ctx) =>
    sensor(ctx, {
      value_template:
        "{{ (value_json.value.currentApp | default('inconnu')) if value_json.value.power else 'off' }}",
      icon: 'mdi:television',
    }),

  tempo: (ctx) =>
    sensor(ctx, {
      value_template: '{{ value_json.value.couleurJour }}',
      icon: 'mdi:calendar-today',
    }),

  // `WeatherValue` est encore un record libre (affiné en P3) : on expose la
  // température si elle est là, et rien d'autre — pas de device_class tant que
  // le contrat ne garantit pas une valeur numérique.
  weather: (ctx) =>
    sensor(ctx, {
      value_template: "{{ value_json.value.temperature | default('inconnu') }}",
      icon: 'mdi:weather-partly-cloudy',
    }),

  // Volets (P9). Deux canaux, comme le contrat : le topic principal porte les
  // verbes (`open`/`close`/`stop`), le topic `…/position` la consigne chiffrée.
  // `state` n'est publié par le driver que pendant le mouvement : au repos, la
  // position suffit à dire ouvert/fermé — d'où le `default(…)` du template plutôt
  // qu'une config qui exigerait un champ optionnel.
  cover: (ctx) => ({
    component: 'cover',
    config: {
      ...ctx.base,
      device_class: 'shutter',
      state_topic: ctx.state,
      value_template:
        '{{ value_json.value.state | default(' +
        `'open' if value_json.value.position > ${HA_COVER_POSITION_CLOSED} else 'closed') }}`,
      position_topic: ctx.state,
      position_template: '{{ value_json.value.position | round(0) }}',
      position_closed: HA_COVER_POSITION_CLOSED,
      position_open: HA_COVER_POSITION_OPEN,
      command_topic: ctx.cmd(),
      payload_open: HA_COVER_PAYLOAD.open,
      payload_close: HA_COVER_PAYLOAD.close,
      payload_stop: HA_COVER_PAYLOAD.stop,
      set_position_topic: ctx.cmd(HA_FIELD.position),
      // Rend `30` — un nombre JSON, cf. parti pris n°3.
      set_position_template: '{{ position }}',
      // Le retour d'état vient toujours du bus : HA ne suppose jamais le résultat
      // d'une commande (un volet peut être bloqué, ou piloté à la télécommande).
      optimistic: false,
    },
  }),

  button: null,
  doorbell: null,
  lock: null,
} satisfies Record<Kind, KindMapper | null>;

/** Kinds que le pont n'expose jamais à HA (donc jamais à la voix). */
export function isExposedToHa(kind: Kind): boolean {
  return mappers[kind] !== null;
}

function baseConfig(entity: Entity): Record<string, unknown> {
  const room = entity.room ?? HA_DEFAULT_ROOM;
  return {
    name: humanize(entity.id),
    unique_id: haObjectId(entity.id),
    // Disponibilité = santé du driver (LWT, spec §6). Driver mort ⇒ entité
    // « indisponible » dans HA plutôt qu'un dernier état affiché comme frais.
    availability_topic: healthTopic(entity.driver),
    availability_template: '{{ value_json.status }}',
    payload_available: 'online',
    payload_not_available: 'offline',
    json_attributes_topic: stateTopic(entity.driver, entity.id),
    json_attributes_template: ATTRIBUTES_TEMPLATE,
    // Regroupement par pièce : c'est ce qui donne à HA une zone exploitable par
    // les intents (« allume la lumière du salon ») sans une ligne de config chez lui.
    device: {
      identifiers: [`stellar_${room}`],
      name: room,
      manufacturer: MANUFACTURER,
      model: MODEL,
    },
  };
}

/**
 * Config de découverte d'une entité, ou `null` si son `kind` n'est pas exposé.
 *
 * La config ne dépend **que** de l'identité de l'entité (id, kind, room, driver,
 * unit) — jamais de sa valeur. C'est ce qui rend la déduplication du pont efficace :
 * un capteur qui parle toutes les 30 s ne republie pas sa config.
 */
export function buildHaDiscovery(
  entity: Entity,
  discoveryPrefix: string = HA_DISCOVERY_DEFAULT_PREFIX,
): HaDiscovery | null {
  const mapper: KindMapper | null = mappers[entity.kind];
  if (mapper === null) return null;

  const state = stateTopic(entity.driver, entity.id);
  const { component, config } = mapper({
    entity,
    state,
    base: baseConfig(entity),
    cmd: (field) => haCommandTopic(entity.id, field),
  });
  const objectId = haObjectId(entity.id);

  return {
    component,
    objectId,
    topic: `${discoveryPrefix}/${component}/${objectId}/config`,
    config,
  };
}
