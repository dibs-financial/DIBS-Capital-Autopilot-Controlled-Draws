import { DrawError } from './errors.js';

export const S = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  HELD: 'HELD',
  REQUIRES_INFORMATION: 'REQUIRES_INFORMATION',
  APPROVED: 'APPROVED',
  SETTLEMENT_INSTRUCTED: 'SETTLEMENT_INSTRUCTED',
  SETTLEMENT_CONFIRMED: 'SETTLEMENT_CONFIRMED',
  RECONCILED: 'RECONCILED',
  RECONCILIATION_EXCEPTION: 'RECONCILIATION_EXCEPTION',
  CLOSED: 'CLOSED',
});

/** The only state machine. There is no second CapitalRequest machine. */
export const TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'HELD', 'REQUIRES_INFORMATION'],
  UNDER_REVIEW: ['APPROVED', 'HELD'],
  HELD: ['SUBMITTED'],
  REQUIRES_INFORMATION: ['SUBMITTED'],
  APPROVED: ['SETTLEMENT_INSTRUCTED', 'UNDER_REVIEW'], // UNDER_REVIEW = binding break
  SETTLEMENT_INSTRUCTED: ['SETTLEMENT_CONFIRMED'],
  SETTLEMENT_CONFIRMED: ['RECONCILED', 'RECONCILIATION_EXCEPTION'],
  RECONCILIATION_EXCEPTION: ['SETTLEMENT_CONFIRMED'], // corrected partner confirmation only
  RECONCILED: ['CLOSED'],
  CLOSED: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new DrawError('ILLEGAL_TRANSITION', `${from} → ${to} is not allowed`, { from, to });
  }
}
