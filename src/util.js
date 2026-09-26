import { createHash } from 'node:crypto';

/** Deterministic JSON: sorted keys, bigint tagged, undefined dropped. */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical: non-finite number');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function hashOf(value) {
  return sha256Hex(canonical(value));
}

export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function toDate(value, field) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} is not a valid date`);
  return d;
}
