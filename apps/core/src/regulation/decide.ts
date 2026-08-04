import type { RegulationConfig, RoomConfig } from './regulation-config.js';
import { derivePeriode, inTimeRange, localTime, parseTimeOfDay } from './time.js';
import type {
  ActuatorRole,
  ActuatorState,
  Decision,
  EnergyEvaluation,
  OccupancyMode,
  Outcome,
  RoomEvaluation,
  RoomSnapshot,
  Snapshot,
} from './types.js';

/**
 * Le cœur de la régulation (spec §10, phase P6) : **une fonction pure**.
 *
 * `decide(snapshot, config, now)` ne lit rien, n'écrit rien, ne connaît ni le bus
 * ni le miroir. Toute sa mémoire (délestage en cours, alertes déjà criées, date
 * de la dernière bascule de chaque actionneur) entre par le snapshot et ressort
 * par l'outcome — c'est ce qui rend les golden tests possibles, et c'est aussi ce
 * qui garantit qu'une même situation produit toujours la même décision.
 *
 * L'ordre d'un tick est significatif :
 *
 * 1. **délestage** — protéger le disjoncteur passe avant le confort ; un
 *    actionneur délesté est marqué et le thermostat ne le rallume pas ;
 * 2. **pièces**, dans l'ordre de la config ;
 * 3. **agrégation du chauffage central** — plusieurs pièces peuvent partager un
 *    thermostat : on lui pousse la plus haute des consignes demandées.
 */

const MINUTE = 60_000;

/** Consignes et températures se comparent au dixième : ce sont des °C, pas des flottants. */
const round1 = (value: number): number => Math.round(value * 10) / 10;
const sameTemp = (a: number, b: number): boolean => Math.abs(a - b) < 0.05;
const t = (value: number): string => value.toFixed(1);
const va = (value: number): string => Math.round(value).toString();

type Availability = 'absent' | 'unknown' | 'offline' | 'stale' | 'shed' | 'ok';

const NOTHING_SHED: ReadonlySet<string> = new Set<string>();

const AVAILABILITY_LABELS: Readonly<Record<Availability, string>> = {
  absent: 'non déclaré',
  unknown: 'inconnu du miroir',
  offline: 'driver hors ligne',
  stale: 'muet',
  shed: 'délesté',
  ok: 'disponible',
};

function availabilityOf(
  actuator: ActuatorState | undefined,
  shed: ReadonlySet<string>,
): Availability {
  if (!actuator) return 'absent';
  if (!actuator.known) return 'unknown';
  if (!actuator.driverOnline) return 'offline';
  if (actuator.stale) return 'stale';
  if (shed.has(actuator.entityId)) return 'shed';
  return 'ok';
}

/**
 * Une donnée reste lisible même sur un actionneur qu'on n'a pas le droit de
 * piloter : un délestage coupe la clim, il n'aveugle pas sa sonde.
 */
function readableTemp(actuator: ActuatorState | undefined): ActuatorState | undefined {
  if (!actuator || actuator.indoorTemp === undefined) return undefined;
  const availability = availabilityOf(actuator, NOTHING_SHED);
  return availability === 'ok' || availability === 'shed' ? actuator : undefined;
}

/**
 * Politique énergie du moment (spec §10).
 *
 * Interprétations assumées, faute de règle explicite dans la spec :
 *
 * - **percept tempo absent ou stale → « bleu prudent »** : PAC autorisées (sans
 *   elles la maison ne chauffe pas), mais aucune préchauffe (on ne dépense pas
 *   sur une couleur qu'on ne connaît pas). La période HP/HC est alors déduite de
 *   l'heure locale (6 h–22 h, spec §2).
 * - **blanc = « préférer le moins cher »** : en heures creuses, le kWh électrique
 *   blanc reste modéré et le COP de la PAC (~3) bat largement la chaudière gaz →
 *   PAC prioritaire ; en heures pleines le kWh blanc grimpe et la chaudière
 *   repasse devant → central prioritaire. Une pièce qui n'a qu'un actionneur
 *   l'utilise, évidemment.
 * - **bleu** : PAC prioritaire partout (meilleur rendement que le gaz au tarif
 *   normal), chaudière en secours.
 */
function evaluateEnergy(
  snapshot: Snapshot,
  config: RegulationConfig,
  minutesOfDay: number,
): EnergyEvaluation {
  const tempo = snapshot.tempo;

  if (!tempo || tempo.stale) {
    const periode = derivePeriode(minutesOfDay);
    return {
      periode,
      pacAllowed: true,
      preferred: 'pac',
      preheatDelta: 0,
      source: 'fallback',
      label: `couleur du jour indisponible → bleu prudent, ${periode} (heure locale)`,
    };
  }

  const { couleurJour, couleurDemain, periode } = tempo;
  const rouge = config.energy.tempo_rouge;
  const policy = periode === 'HP' ? rouge.hp.pac : rouge.hc.pac;

  // Préchauffe : demain rouge, après l'heure de départ, et **uniquement** pendant
  // les heures creuses — c'est tout l'intérêt, prendre l'avance quand c'est donné.
  const preheatStart = parseTimeOfDay(config.energy.preheat_before_red.start);
  const preheatActive =
    couleurDemain === 'rouge' && periode === 'HC' && minutesOfDay >= preheatStart;
  const preheatDelta = preheatActive ? config.energy.preheat_before_red.delta : 0;

  let pacAllowed = true;
  let preferred: ActuatorRole = 'pac';
  let label = `jour ${couleurJour} ${periode}`;

  if (couleurJour === 'rouge') {
    pacAllowed = policy === 'allowed';
    preferred = pacAllowed ? 'pac' : 'central';
    label = pacAllowed
      ? `jour rouge ${periode} (PAC autorisée en heures creuses)`
      : `jour rouge ${periode} (PAC interdite)`;
  } else if (couleurJour === 'blanc') {
    preferred = periode === 'HC' ? 'pac' : 'central';
    label = `jour blanc ${periode} (${preferred === 'pac' ? 'PAC' : 'chaudière'} moins chère)`;
  }

  if (preheatActive) {
    label += ` · demain rouge, préchauffe +${t(preheatDelta)} °C`;
  }

  return {
    periode,
    couleurJour,
    couleurDemain,
    pacAllowed,
    preferred,
    preheatDelta,
    source: 'percept',
    label,
  };
}

interface Guard {
  allowed: boolean;
  /** Minutes depuis la dernière bascule, `Infinity` si jamais basculé. */
  sinceMin: number;
}

interface CentralRequest {
  entityId: string;
  setpoint: number;
  room: string;
  cause: string;
  actuator: ActuatorState;
}

/**
 * Délestage (spec §10) — évalué à chaque tick **et** à chaque nouvel état de
 * puissance, donc à la seconde près en pratique.
 *
 * Une seule bascule par évaluation : on coupe le premier de `shed_order` encore
 * armé, puis on attend la mesure suivante pour savoir si ça suffit. Couper les
 * trois d'un coup sur une seule lecture serait un pari — le compteur, lui, répond
 * en une ou deux secondes.
 *
 * La **coupure** ignore l'anti-court-cycle (protéger l'abonnement passe avant le
 * compresseur) ; le **réarmement** le respecte, c'est lui qui pourrait osciller.
 */
function evaluateDelestage(
  snapshot: Snapshot,
  config: RegulationConfig,
  shed: Set<string>,
  raiseAlert: (key: string) => boolean,
  guard: (entityId: string) => Guard,
): Decision[] {
  const decisions: Decision[] = [];
  const power = snapshot.power;
  const { max_va, margin_va, rearm_va, shed_order } = config.delestage;

  if (shed_order.length === 0) return decisions;

  // Sans mesure fiable on ne coupe pas (on n'a pas de raison) et surtout on ne
  // réarme pas (on n'a pas de preuve que c'est redevenu sûr) : l'état tient.
  if (!power || power.stale) {
    if (shed.size > 0 && raiseAlert('delestage_sans_mesure')) {
      decisions.push({
        room: 'maison',
        decision: 'delestage_sans_mesure',
        severity: 'alert',
        alertKey: 'delestage_sans_mesure',
        cause: `puissance instantanée indisponible : ${[...shed].join(', ')} reste(nt) délesté(s) par prudence`,
      });
    }
    return decisions;
  }

  const shedThreshold = max_va - margin_va;

  if (power.va > shedThreshold) {
    const actuators = new Map(
      snapshot.rooms.flatMap((room) =>
        room.pac ? ([[room.pac.entityId, room.pac]] as Array<[string, ActuatorState]>) : [],
      ),
    );
    for (const entityId of shed_order) {
      if (shed.has(entityId)) continue;
      const actuator = actuators.get(entityId);
      const availability = availabilityOf(actuator, NOTHING_SHED);
      // Marqué délesté quoi qu'il arrive : même injoignable, le thermostat ne doit
      // pas tenter de le rallumer tant que le pic dure.
      shed.add(entityId);
      const cause =
        `puissance ${va(power.va)} VA > ${va(shedThreshold)} VA ` +
        `(${va(max_va)} − ${va(margin_va)}) → délestage de ${entityId}`;

      if (availability === 'ok' && actuator?.power === true) {
        decisions.push({
          room: 'maison',
          decision: 'delestage',
          severity: 'action',
          cause,
          command: { target: entityId, action: 'set', params: { power: false } },
        });
      } else {
        decisions.push({
          room: 'maison',
          decision: 'delestage_sans_effet',
          severity: 'action',
          cause: `${cause} (déjà à l'arrêt ou injoignable : ${AVAILABILITY_LABELS[availability]})`,
        });
      }
      return decisions;
    }

    if (raiseAlert('delestage_impossible')) {
      decisions.push({
        room: 'maison',
        decision: 'delestage_impossible',
        severity: 'alert',
        alertKey: 'delestage_impossible',
        cause: `puissance ${va(power.va)} VA > ${va(shedThreshold)} VA mais plus rien à délester`,
      });
    }
    return decisions;
  }

  if (power.va < rearm_va && shed.size > 0) {
    // Ordre inverse : le dernier coupé est le premier réarmé.
    for (const entityId of [...shed_order].reverse()) {
      if (!shed.has(entityId)) continue;
      const { allowed, sinceMin } = guard(entityId);
      if (!allowed) {
        decisions.push({
          room: 'maison',
          decision: 'rearmement_differe',
          severity: 'blocked',
          cause:
            `puissance ${va(power.va)} VA < ${va(rearm_va)} VA mais ${entityId} a basculé ` +
            `il y a ${sinceMin.toFixed(0)} min < ${config.anti_short_cycle_min} min (anti-court-cycle)`,
        });
        return decisions;
      }
      shed.delete(entityId);
      decisions.push({
        room: 'maison',
        decision: 'rearmement',
        severity: 'action',
        cause:
          `puissance ${va(power.va)} VA < ${va(rearm_va)} VA (seuil de réarmement) → ` +
          `${entityId} rendu au thermostat`,
      });
      return decisions;
    }
  }

  return decisions;
}

/**
 * Mode d'occupation de la pièce.
 *
 * Choix assumé : **une pièce sans capteur de présence exploitable est considérée
 * occupée en journée**. Se tromper dans ce sens coûte quelques centimes ; se
 * tromper dans l'autre, c'est rentrer dans une pièce froide — et personne
 * n'installe un capteur de présence dans chaque pièce.
 *
 * Un capteur qui vient de passer à `false` garde la pièce « occupée » pendant
 * `presence_timeout_min` : c'est la lecture littérale de « présence vue il y a
 * moins de N minutes », et ça absorbe les clignotements des mmWave.
 */
function occupancyOf(room: RoomSnapshot, config: RegulationConfig, now: number): OccupancyMode {
  const usable = room.presence.filter((reading) => !reading.stale);
  if (usable.length === 0) return 'present';
  if (usable.some((reading) => reading.value)) return 'present';
  const timeoutMs = config.presence_timeout_min * MINUTE;
  if (usable.some((reading) => now - reading.ts < timeoutMs)) return 'present';
  return 'absent';
}

interface RoomOutput {
  evaluation: RoomEvaluation;
  centralRequest?: CentralRequest;
}

function evaluateRoom(
  room: RoomSnapshot,
  roomConfig: RoomConfig,
  config: RegulationConfig,
  energy: EnergyEvaluation,
  minutesOfDay: number,
  now: number,
  shed: ReadonlySet<string>,
  raiseAlert: (key: string) => boolean,
  guard: (entityId: string) => Guard,
): RoomOutput {
  const decisions: Decision[] = [];
  const name = room.room;

  const pacAvailability = availabilityOf(room.pac, shed);
  const centralAvailability = availabilityOf(room.central, shed);

  // Anomalies matérielles : signalées une fois, jamais bloquantes en elles-mêmes.
  for (const [actuator, availability] of [
    [room.pac, pacAvailability],
    [room.central, centralAvailability],
  ] as Array<[ActuatorState | undefined, Availability]>) {
    if (!actuator) continue;
    if (availability === 'unknown' && raiseAlert(`entite_inconnue:${actuator.entityId}`)) {
      decisions.push({
        room: name,
        decision: 'entite_inconnue',
        severity: 'alert',
        alertKey: `entite_inconnue:${actuator.entityId}`,
        cause: `${actuator.entityId} est déclaré en configuration mais absent du miroir`,
      });
    } else if (availability === 'offline' && raiseAlert(`driver_offline:${actuator.entityId}`)) {
      decisions.push({
        room: name,
        decision: 'driver_offline',
        severity: 'alert',
        alertKey: `driver_offline:${actuator.entityId}`,
        cause: `le driver de ${actuator.entityId} est hors ligne → aucune commande vers cette entité`,
      });
    } else if (availability === 'stale' && raiseAlert(`equipement_muet:${actuator.entityId}`)) {
      decisions.push({
        room: name,
        decision: 'equipement_muet',
        severity: 'alert',
        alertKey: `equipement_muet:${actuator.entityId}`,
        cause: `${actuator.entityId} est muet (stale) → aucune commande vers cette entité`,
      });
    }
  }

  // 1. Température mesurée : capteurs de la pièce, puis la clim, puis rien.
  const sensor = room.sensors.find((reading) => !reading.stale);
  const pacFallback = readableTemp(room.pac);
  const temperature = sensor?.value ?? pacFallback?.indoorTemp;
  const temperatureSource =
    sensor?.entityId ?? (pacFallback ? `${pacFallback.entityId}.indoorTemp` : undefined);
  const degraded = temperature === undefined;

  // 2. Mode d'occupation, 3. consigne (+ préchauffe).
  const nightStart = parseTimeOfDay(config.night.start);
  const nightEnd = parseTimeOfDay(config.night.end);
  const nuit = inTimeRange(minutesOfDay, nightStart, nightEnd);
  const mode: OccupancyMode = degraded
    ? 'hors_gel'
    : nuit
      ? 'nuit'
      : occupancyOf(room, config, now);
  const preheat = !degraded && energy.preheatDelta > 0;
  const setpoint = round1(roomConfig.setpoints[mode] + (preheat ? energy.preheatDelta : 0));

  const evaluation: RoomEvaluation = {
    room: name,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(temperatureSource !== undefined ? { temperatureSource } : {}),
    degraded,
    mode,
    setpoint,
    preheat,
    decisions,
  };

  /** Bascule marche/arrêt d'une PAC, sous contrainte d'anti-court-cycle. */
  const togglePac = (actuator: ActuatorState, power: boolean, cause: string): void => {
    const { allowed, sinceMin } = guard(actuator.entityId);
    if (!allowed) {
      decisions.push({
        room: name,
        decision: power ? 'marche_differee' : 'arret_differe',
        severity: 'blocked',
        cause:
          `${cause} — bascule différée : dernière bascule il y a ${sinceMin.toFixed(0)} min ` +
          `< ${config.anti_short_cycle_min} min (anti-court-cycle)`,
      });
      return;
    }
    decisions.push({
      room: name,
      decision: power ? 'pac_marche' : 'pac_arret',
      severity: 'action',
      cause,
      command: {
        target: actuator.entityId,
        action: 'set',
        params: power ? { power: true, mode: 'heat', targetTemp: setpoint } : { power: false },
      },
    });
  };

  /** Consigne poussée à une PAC déjà en marche : pas une bascule, pas de contrainte. */
  const adjustPac = (actuator: ActuatorState, cause: string): void => {
    if (actuator.mode === 'heat' && sameTemp(actuator.targetTemp, setpoint)) return;
    decisions.push({
      room: name,
      decision: 'pac_consigne',
      severity: 'action',
      cause,
      command: {
        target: actuator.entityId,
        action: 'set',
        params: { mode: 'heat', targetTemp: setpoint },
      },
    });
  };

  // 4. Mode dégradé : aucune mesure → consigne conservatrice, PAC à l'arrêt.
  if (degraded) {
    const sensorNames = [
      ...room.sensors.map((reading) => reading.entityId),
      ...(room.pac ? [`${room.pac.entityId}.indoorTemp`] : []),
    ];
    if (raiseAlert(`capteur_indisponible:${name}`)) {
      decisions.push({
        room: name,
        decision: 'capteur_indisponible',
        severity: 'alert',
        alertKey: `capteur_indisponible:${name}`,
        cause:
          `aucune mesure exploitable (${sensorNames.join(', ') || 'aucun capteur déclaré'}) → ` +
          `consigne conservatrice hors-gel ${t(setpoint)} °C`,
      });
    }
    if (pacAvailability === 'ok' && room.pac?.power === true) {
      togglePac(
        room.pac,
        false,
        `aucune mesure exploitable dans ${name} → arrêt de la PAC (on ne chauffe pas à l'aveugle)`,
      );
    }
    if (centralAvailability === 'ok' && room.central) {
      return {
        evaluation,
        centralRequest: {
          entityId: room.central.entityId,
          setpoint,
          room: name,
          actuator: room.central,
          cause: `aucune mesure exploitable dans ${name} → consigne hors-gel ${t(setpoint)} °C au chauffage central`,
        },
      };
    }
    return { evaluation };
  }

  // 5. Choix de l'actionneur : politique énergie d'abord, préférence ensuite.
  const candidates: ActuatorState[] = [];
  if (room.pac && pacAvailability === 'ok' && energy.pacAllowed) candidates.push(room.pac);
  if (room.central && centralAvailability === 'ok') candidates.push(room.central);
  candidates.sort(
    (a, b) => Number(b.role === energy.preferred) - Number(a.role === energy.preferred),
  );
  const chosen = candidates[0];

  // Une PAC utilisable mais écartée (interdite, ou chaudière moins chère) ne doit
  // pas continuer à tourner dans le dos de la décision.
  if (room.pac && pacAvailability === 'ok' && chosen?.role !== 'pac' && room.pac.power) {
    togglePac(
      room.pac,
      false,
      energy.pacAllowed
        ? `${energy.label} → chauffage central préféré, arrêt de ${room.pac.entityId}`
        : `${energy.label} → arrêt de ${room.pac.entityId}`,
    );
  }

  if (!chosen) {
    // Délestage : conséquence assumée d'une décision déjà tracée, pas une panne.
    if (pacAvailability === 'shed') {
      decisions.push({
        room: name,
        decision: 'pac_delestee',
        severity: 'blocked',
        cause: `${room.pac?.entityId ?? name} est délestée → ${name} ne chauffe pas tant que le pic dure`,
      });
      return { evaluation };
    }
    const pacForbidden = room.pac && pacAvailability === 'ok' && !energy.pacAllowed;
    const key = pacForbidden ? `pac_interdite_sans_secours:${name}` : `sans_actionneur:${name}`;
    if (raiseAlert(key)) {
      decisions.push({
        room: name,
        decision: pacForbidden ? 'pac_interdite_sans_secours' : 'sans_actionneur',
        severity: 'alert',
        alertKey: key,
        cause: pacForbidden
          ? `${energy.label} et ${name} n'a pas de chauffage central → pièce non chauffée, on subit`
          : `aucun actionneur disponible dans ${name} (pac : ${AVAILABILITY_LABELS[pacAvailability]}, ` +
            `central : ${AVAILABILITY_LABELS[centralAvailability]})`,
      });
    }
    return { evaluation };
  }

  evaluation.chosen = chosen.role;

  // 6. Hystérésis : sous la bande → chauffe, au-dessus → arrêt, dedans → statu quo.
  const h = config.hysteresis;
  const low = round1(setpoint - h);
  const high = round1(setpoint + h);
  const wantHeat = temperature < low ? true : temperature > high ? false : undefined;
  const band = `consigne ${t(setpoint)} ± ${t(h)} (mode ${mode}${preheat ? ', préchauffe' : ''})`;

  if (chosen.role === 'central') {
    // Le thermostat gère sa propre boucle : on lui pousse la consigne, point.
    // Jamais d'arrêt (spec §10) — c'est lui qui décide d'allumer la chaudière.
    return {
      evaluation,
      centralRequest: {
        entityId: chosen.entityId,
        setpoint,
        room: name,
        actuator: chosen,
        cause: `${t(temperature)} °C, ${band} · ${energy.label} → consigne ${t(setpoint)} °C au chauffage central`,
      },
    };
  }

  if (wantHeat === true && !chosen.power) {
    togglePac(
      chosen,
      true,
      `${t(temperature)} °C < ${t(low)} °C (${band}) · ${energy.label} → marche de ${chosen.entityId}`,
    );
  } else if (wantHeat === false && chosen.power) {
    togglePac(
      chosen,
      false,
      `${t(temperature)} °C > ${t(high)} °C (${band}) · ${energy.label} → arrêt de ${chosen.entityId}`,
    );
  } else if (chosen.power) {
    // En marche et dans la bande (ou déjà au bon état) : seule la consigne bouge.
    adjustPac(
      chosen,
      `${t(temperature)} °C dans la bande, ${band} · ${energy.label} → consigne ${t(setpoint)} °C sur ${chosen.entityId}`,
    );
  }

  // La PAC chauffe : la chaudière est **parquée au hors-gel**. Sans ça elle
  // resterait sur sa dernière consigne et chaufferait en parallèle — « préférer
  // le moins cher » n'aurait aucun effet. Corollaire assumé : le core prend la
  // main complète sur le thermostat central, donc les pièces qui en dépendent
  // sans figurer dans `rooms:` ne sont plus chauffées. C'est le `hors_gel` de la
  // pièce qui règle ce parcage (cf. commentaire de config/regulation.yaml).
  if (room.central && centralAvailability === 'ok') {
    const parked = round1(roomConfig.setpoints.hors_gel);
    return {
      evaluation,
      centralRequest: {
        entityId: room.central.entityId,
        setpoint: parked,
        room: name,
        actuator: room.central,
        cause:
          `${energy.label} → ${chosen.entityId} chauffe ${name}, ` +
          `chauffage central parqué au hors-gel ${t(parked)} °C`,
      },
    };
  }

  return { evaluation };
}

export function decide(snapshot: Snapshot, config: RegulationConfig, now: number): Outcome {
  const local = localTime(now, config.timezone);
  const shed = new Set(snapshot.shed);
  const previousAlerts = new Set(snapshot.alerts);
  /** Alertes actives à ce tick — celles qui disparaissent redeviennent criables. */
  const alerts = new Set<string>();

  const raiseAlert = (key: string): boolean => {
    alerts.add(key);
    return !previousAlerts.has(key);
  };

  const guard = (entityId: string): Guard => {
    const last = snapshot.lastPowerChangeAt[entityId];
    if (last === undefined) return { allowed: true, sinceMin: Number.POSITIVE_INFINITY };
    const sinceMin = (now - last) / MINUTE;
    return { allowed: sinceMin >= config.anti_short_cycle_min, sinceMin };
  };

  const energy = evaluateEnergy(snapshot, config, local.minutesOfDay);
  const global = evaluateDelestage(snapshot, config, shed, raiseAlert, guard);

  const rooms: RoomEvaluation[] = [];
  const centralRequests: CentralRequest[] = [];
  for (const roomSnapshot of snapshot.rooms) {
    const roomConfig = config.rooms[roomSnapshot.room];
    if (!roomConfig) continue;
    const output = evaluateRoom(
      roomSnapshot,
      roomConfig,
      config,
      energy,
      local.minutesOfDay,
      now,
      shed,
      raiseAlert,
      guard,
    );
    rooms.push(output.evaluation);
    if (output.centralRequest) centralRequests.push(output.centralRequest);
  }

  // Agrégation du chauffage central : plusieurs pièces peuvent partager le même
  // thermostat (une chaudière, toute la maison). On retient la consigne la plus
  // haute — la baisser au nom d'une pièce en refroidirait une autre.
  const byCentral = new Map<string, CentralRequest[]>();
  for (const request of centralRequests) {
    const list = byCentral.get(request.entityId);
    if (list) list.push(request);
    else byCentral.set(request.entityId, [request]);
  }
  for (const requests of byCentral.values()) {
    const winner = requests.reduce((best, current) =>
      current.setpoint > best.setpoint ? current : best,
    );
    if (sameTemp(winner.actuator.targetTemp, winner.setpoint)) continue;
    const shared =
      requests.length > 1 ? ` (plus haute consigne demandée par ${requests.length} pièces)` : '';
    const target = rooms.find((evaluation) => evaluation.room === winner.room);
    target?.decisions.push({
      room: winner.room,
      decision: 'central_consigne',
      severity: 'action',
      cause: `${winner.cause}${shared}`,
      command: {
        target: winner.entityId,
        action: 'set',
        params: { targetTemp: winner.setpoint },
      },
    });
  }

  return {
    now,
    local,
    energy,
    rooms,
    global,
    decisions: [...global, ...rooms.flatMap((evaluation) => evaluation.decisions)],
    shed: [...shed],
    alerts: [...alerts],
  };
}
