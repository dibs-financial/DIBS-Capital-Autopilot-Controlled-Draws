import { DrawError } from './errors.js';

/**
 * Money is integer minor units (cents) as bigint. Floats are refused, not rounded.
 */
export function parseMinor(value, field = 'amountMinor') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new DrawError('VALIDATION', `${field} must not be negative`);
    return value;
  }
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) return BigInt(value);
  throw new DrawError(
    'VALIDATION',
    `${field} must be integer minor units (bigint or digit string); got ${typeof value}`,
  );
}

/** Basis-point share, rounded up (lender-conservative for retainage). */
export function ceilBps(minor, bps) {
  const b = BigInt(bps);
  return (minor * b + 9_999n) / 10_000n;
}

export function sum(values) {
  return values.reduce((a, b) => a + b, 0n);
}

export function formatUsd(minor) {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${cents}`;
}

/** Convenience for tests, seeds, and demos: usd(300_000) === 30_000_000n. */
export function usd(wholeDollars) {
  if (!Number.isSafeInteger(wholeDollars)) throw new TypeError('usd() takes whole dollars');
  return BigInt(wholeDollars) * 100n;
}
