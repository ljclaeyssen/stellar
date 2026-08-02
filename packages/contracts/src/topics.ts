export const TOPIC_ROOT = 'home';

export const stateTopic = (driver: string, entityId: string): string =>
  `${TOPIC_ROOT}/state/${driver}/${entityId}`;
export const cmdTopic = (driver: string, entityId: string): string =>
  `${TOPIC_ROOT}/cmd/${driver}/${entityId}`;
export const eventTopic = (driver: string, type: string): string =>
  `${TOPIC_ROOT}/event/${driver}/${type}`;
export const discoveryTopic = (driver: string): string => `${TOPIC_ROOT}/discovery/${driver}`;
export const healthTopic = (driver: string): string => `${TOPIC_ROOT}/health/${driver}`;
/** Fallback req/resp quand les propriétés MQTT 5 ne sont pas disponibles. */
export const ackTopic = (commandId: string): string => `${TOPIC_ROOT}/ack/${commandId}`;

export interface StateTopicParts {
  driver: string;
  entityId: string;
}

export function parseStateTopic(topic: string): StateTopicParts | null {
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== TOPIC_ROOT || parts[1] !== 'state') return null;
  const [, , driver, entityId] = parts;
  if (!driver || !entityId) return null;
  return { driver, entityId };
}

/** Matcher de filtre MQTT ('+' un niveau, '#' le reste). */
export function matchTopic(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#') return true;
    if (i >= t.length) return false;
    if (seg !== '+' && seg !== t[i]) return false;
  }
  return f.length === t.length;
}
