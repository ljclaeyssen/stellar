import { z } from 'zod';

/**
 * Contrats zod de la frontière HTTP avec le cloud Netatmo (règle n°4 de la spec).
 *
 * Tous les objets sont en `.passthrough()` : Netatmo ajoute des champs sans
 * prévenir, les ignorer vaut mieux que rejeter une réponse entière. À l'inverse,
 * un champ *attendu* absent ou mal typé fait échouer la ressource, qui est loggée
 * et sautée (jamais de crash).
 *
 * Presque tout est `optional()` à dessein : un thermostat hors ligne ne renvoie
 * ni température mesurée ni consigne, un module sans pile ne renvoie pas de
 * `dashboard_data`. C'est au mapping de décider ce qu'il peut publier.
 */

/** Enveloppe commune : `{ status, body }`. `body` reste brut, filtré ensuite. */
export const NetatmoEnvelope = z
  .object({ status: z.string().optional(), body: z.unknown() })
  .passthrough();

/** Réponse d'écriture (`setroomthermpoint`, `setthermmode`). */
export const NetatmoWriteResponse = z.object({ status: z.string() }).passthrough();

// ---------------------------------------------------------------- OAuth2

/**
 * `POST /oauth2/token`. **`refresh_token` est requis** : Netatmo fait tourner le
 * refresh à chaque appel, une réponse sans nouveau refresh signifierait qu'on a
 * perdu le nôtre (spec §9). On préfère échouer bruyamment que continuer aveugle.
 */
export const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().positive().default(10_800),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof TokenResponse>;

/** Erreur OAuth2 (RFC 6749) : `{ "error": "invalid_grant" }`. */
export const OAuthError = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .passthrough();

// ---------------------------------------------------------------- Energy

export const HomesDataRoom = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().optional(),
    module_ids: z.array(z.string()).default([]),
  })
  .passthrough();
export type HomesDataRoom = z.infer<typeof HomesDataRoom>;

export const HomesDataModule = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    name: z.string().optional(),
    room_id: z.string().optional(),
    bridge: z.string().optional(),
  })
  .passthrough();
export type HomesDataModule = z.infer<typeof HomesDataModule>;

export const HomesDataHome = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).default('Maison'),
    rooms: z.array(HomesDataRoom).default([]),
    modules: z.array(HomesDataModule).default([]),
  })
  .passthrough();
export type HomesDataHome = z.infer<typeof HomesDataHome>;

/**
 * Modes de consigne Netatmo tels qu'ils arrivent dans `therm_setpoint_mode`.
 * Laissé en `string` : un mode inconnu ne doit pas faire disparaître la room,
 * le mapping le traite comme « pas de chauffe » et le logue.
 */
export const HomeStatusRoom = z
  .object({
    id: z.string().min(1),
    reachable: z.boolean().optional(),
    therm_measured_temperature: z.number().optional(),
    therm_setpoint_temperature: z.number().optional(),
    therm_setpoint_mode: z.string().optional(),
  })
  .passthrough();
export type HomeStatusRoom = z.infer<typeof HomeStatusRoom>;

export const HomeStatusModule = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    reachable: z.boolean().optional(),
    battery_percent: z.number().optional(),
    battery_state: z.string().optional(),
  })
  .passthrough();
export type HomeStatusModule = z.infer<typeof HomeStatusModule>;

/** `body.home` : les listes restent brutes, validées élément par élément. */
export const HomeStatusEnvelope = z
  .object({
    id: z.string().min(1),
    rooms: z.array(z.unknown()).default([]),
    modules: z.array(z.unknown()).default([]),
  })
  .passthrough();

export interface HomeStatus {
  id: string;
  rooms: HomeStatusRoom[];
  modules: HomeStatusModule[];
}

// ---------------------------------------------------------------- Station

export const Dashboard = z
  .object({
    time_utc: z.number().optional(),
    Temperature: z.number().optional(),
    Humidity: z.number().optional(),
    CO2: z.number().optional(),
    Pressure: z.number().optional(),
    AbsolutePressure: z.number().optional(),
    Noise: z.number().optional(),
  })
  .passthrough();
export type Dashboard = z.infer<typeof Dashboard>;

/**
 * Un module de station. Le NAMain (la station elle-même) porte les mêmes champs
 * de mesure que ses modules : le driver les traite à plat, seul `type` les
 * distingue (NAMain = intérieur + pression/bruit/CO2, NAModule1 = extérieur).
 */
export const StationModule = z
  .object({
    _id: z.string().min(1),
    module_name: z.string().optional(),
    type: z.string().min(1),
    reachable: z.boolean().optional(),
    battery_percent: z.number().optional(),
    dashboard_data: Dashboard.optional(),
  })
  .passthrough();
export type StationModule = z.infer<typeof StationModule>;

export const StationDevice = z
  .object({
    _id: z.string().min(1),
    station_name: z.string().optional(),
    module_name: z.string().optional(),
    type: z.string().min(1),
    reachable: z.boolean().optional(),
    dashboard_data: Dashboard.optional(),
    modules: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type StationDevice = z.infer<typeof StationDevice>;

/** Station à plat : le NAMain est le premier module de la liste. */
export interface NetatmoStation {
  id: string;
  /** Nom de la station tel qu'affiché dans l'app (`station_name`). */
  stationName: string;
  modules: StationModule[];
  /** Payload brut, pour le dump `verify`. */
  raw: StationDevice;
}
