import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Journal SQLite append-only (P5, spec §10).
 *
 * Trois partis pris, tous assumés :
 *
 * 1. **Le journal est un fait, pas une opinion.** Tout message reçu sous `home/#`
 *    y entre, y compris les payloads invalides (`kind` null, payload brut) et les
 *    effacements de retained (payload vide). On ne déduplique PAS les
 *    republications identiques d'une même entité : le disque est grand, et un
 *    journal qui filtre ne permet plus de répondre « à quelle fréquence ce
 *    capteur a-t-il parlé ? » — question qui est exactement l'objet de la
 *    détection stale et du prédictif P9.
 * 2. **`ts` est l'heure d'observation**, pas celle du payload. Le payload garde la
 *    sienne (`entity.ts`) ; la colonne dit quand le core a vu passer le fait, ce
 *    qui est la seule chose qu'il puisse affirmer (cf. republication stale, dont
 *    le `ts` d'origine est volontairement conservé).
 * 3. **better-sqlite3 est synchrone dans un process asynchrone** : c'est un choix,
 *    pas un accident. Un `INSERT` local coûte quelques dizaines de µs — bien moins
 *    qu'un aller-retour de boucle d'événements — et la synchronicité supprime
 *    toute file d'attente, tout risque d'écriture perdue à l'arrêt, et toute
 *    question d'ordre. Le jour où le débit poserait problème (il ne le posera pas
 *    à l'échelle d'une maison), la réponse serait un batch par transaction, pas un
 *    driver asynchrone.
 */

/** Ligne telle qu'insérée (l'`id` est attribué par SQLite). */
export interface JournalAppend {
  /** ISO 8601 — défaut : maintenant. */
  ts?: string;
  topic: string;
  payload: string;
  driver?: string | null;
  entityId?: string | null;
  kind?: string | null;
  issuedBy?: string | null;
}

export interface JournalRow {
  id: number;
  ts: string;
  topic: string;
  driver: string | null;
  entityId: string | null;
  kind: string | null;
  payload: string;
  issuedBy: string | null;
}

export interface JournalQuery {
  entityId?: string;
  kind?: string;
  driver?: string;
  /** borne basse inclusive sur `ts` (ISO 8601) */
  from?: string;
  /** borne haute inclusive sur `ts` (ISO 8601) */
  to?: string;
  /** défaut 100 */
  limit?: number;
  /** défaut 'desc' (le plus récent d'abord) */
  order?: 'asc' | 'desc';
}

export interface Journal {
  /** Insère une ligne et retourne son `id`. */
  append(entry: JournalAppend): number;
  query(query?: JournalQuery): JournalRow[];
  count(): number;
  close(): void;
}

export interface JournalOptions {
  /** Chemin du fichier SQLite, ou ':memory:' en test. */
  path: string;
}

export const JOURNAL_DEFAULT_LIMIT = 100;

/** Schéma spec §10, à la virgule près — migrations = `IF NOT EXISTS`. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, topic TEXT NOT NULL,
  driver TEXT, entity_id TEXT, kind TEXT,
  payload TEXT NOT NULL, issued_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_entity_ts ON journal(entity_id, ts);
`;

const SELECT_COLUMNS =
  'id, ts, topic, driver, entity_id AS entityId, kind, payload, issued_by AS issuedBy';

export function createJournal(options: JournalOptions): Journal {
  const { path } = options;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL : lectures (API tRPC) concurrentes des écritures (flux du bus), et
  // surtout pas de corruption sur coupure de courant — le N100 n'a pas d'onduleur.
  // Sans effet sur ':memory:' (le pragma répond 'memory'), c'est sans conséquence.
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO journal (ts, topic, driver, entity_id, kind, payload, issued_by)
     VALUES (@ts, @topic, @driver, @entityId, @kind, @payload, @issuedBy)`,
  );
  // Une transaction par append : le journal doit être durable ligne à ligne (une
  // décision de régulation non journalisée est une décision inexplicable).
  const appendTx = db.transaction((row: Required<JournalAppend>): number => {
    const info = insert.run(row);
    return Number(info.lastInsertRowid);
  });
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM journal');

  /** Les requêtes n'ont que 2^4 formes possibles : on garde les statements préparés. */
  const queryCache = new Map<string, Database.Statement>();
  const prepareQuery = (sql: string): Database.Statement => {
    const cached = queryCache.get(sql);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    queryCache.set(sql, stmt);
    return stmt;
  };

  return {
    append(entry) {
      return appendTx({
        ts: entry.ts ?? new Date().toISOString(),
        topic: entry.topic,
        driver: entry.driver ?? null,
        entityId: entry.entityId ?? null,
        kind: entry.kind ?? null,
        payload: entry.payload,
        issuedBy: entry.issuedBy ?? null,
      });
    },

    query(query = {}) {
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (query.entityId !== undefined) {
        where.push('entity_id = @entityId');
        params['entityId'] = query.entityId;
      }
      if (query.kind !== undefined) {
        where.push('kind = @kind');
        params['kind'] = query.kind;
      }
      if (query.driver !== undefined) {
        where.push('driver = @driver');
        params['driver'] = query.driver;
      }
      if (query.from !== undefined) {
        where.push('ts >= @from');
        params['from'] = query.from;
      }
      if (query.to !== undefined) {
        where.push('ts <= @to');
        params['to'] = query.to;
      }

      // `id` en second critère : deux messages peuvent partager la même
      // milliseconde, l'ordre d'insertion tranche (et rend la requête déterministe).
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';
      const limit = query.limit ?? JOURNAL_DEFAULT_LIMIT;
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM journal` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ts ${direction}, id ${direction} LIMIT @limit`;

      return prepareQuery(sql).all({ ...params, limit }) as JournalRow[];
    },

    count() {
      return (countStmt.get() as { n: number }).n;
    },

    close() {
      db.close();
    },
  };
}

/**
 * Traduit un message du bus en ligne de journal — pure, donc testable sans broker.
 *
 * Les champs indexés (`driver`, `entity_id`, `kind`, `issued_by`) sont extraits du
 * payload quand il est lisible, du topic sinon. Un payload illisible ou vide donne
 * une ligne quand même : cf. le parti pris n°1 ci-dessus.
 */
export function journalEntryFromMessage(topic: string, payload: string, ts: string): JournalAppend {
  const parts = topic.split('/');
  const entry: JournalAppend = { ts, topic, payload };
  if (payload.length === 0) return entry;

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return entry;
  }
  const body: Record<string, unknown> =
    typeof json === 'object' && json !== null ? { ...json } : {};
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  const channel = parts[1];
  const third = parts[2];
  const fourth = parts[3];

  switch (channel) {
    case 'state':
      entry.driver = str(body['driver']) ?? third ?? null;
      entry.entityId = str(body['id']) ?? fourth ?? null;
      entry.kind = str(body['kind']) ?? null;
      break;
    case 'cmd':
      // Le topic porte le driver destinataire, le payload la cible et l'émetteur.
      entry.driver = third ?? null;
      entry.entityId = str(body['target']) ?? fourth ?? null;
      entry.issuedBy = str(body['issuedBy']) ?? null;
      break;
    case 'event':
      entry.driver = str(body['driver']) ?? third ?? null;
      break;
    case 'discovery':
      entry.driver = str(body['driver']) ?? third ?? null;
      break;
    case 'health':
      entry.driver = third ?? null;
      break;
    default:
      // 'ack' (le topic ne porte qu'un commandId) et tout topic futur : le fait est
      // journalisé nu, sans extraction — mieux vaut une ligne sans index qu'un trou.
      break;
  }
  return entry;
}
