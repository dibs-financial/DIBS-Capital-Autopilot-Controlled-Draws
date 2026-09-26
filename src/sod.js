import { DrawError } from './errors.js';

export const ROLES = Object.freeze({
  SPONSOR: 'Sponsor',
  RISK_OWNER: 'RiskOwner',
  UNDERWRITER: 'Underwriter',
  LENDER_ADMIN: 'LenderAdmin',
  TREASURY_OWNER: 'TreasuryOwner',
  SETTLEMENT_PARTNER: 'SettlementPartner',
});

export function hasAnyRole(actor, roles) {
  return actor.roles.some((r) => roles.includes(r));
}

export function requireRole(actor, roles, action) {
  if (!hasAnyRole(actor, roles)) {
    throw new DrawError('ROLE_REQUIRED', `To ${action} you need one of: ${roles.join(', ')}`, { roles });
  }
}

export function requireHuman(actor, code, action) {
  if (actor.kind !== 'human') throw new DrawError(code, `Service accounts cannot ${action}`);
}

/** Requester ≠ approver. Service accounts never approve. One vote per person. */
export function assertCanApprove({ actor, draw, pack, validApprovals }) {
  requireHuman(actor, 'SERVICE_ACCOUNT_CANNOT_APPROVE', 'approve a draw');
  if (actor.id === draw.requestedBy) {
    throw new DrawError('SOD_SELF_APPROVAL', 'The requester of a draw cannot approve it');
  }
  requireRole(actor, pack.approverRoles, 'approve a draw');
  if (validApprovals.some((a) => a.actorId === actor.id)) {
    throw new DrawError('SOD_DUPLICATE_APPROVER', 'You have already approved this binding; dual control needs a different person');
  }
}

/** Instructor is disjoint from requester and from every approver of this draw. */
export function assertCanInstruct({ actor, draw, pack }) {
  requireHuman(actor, 'ROLE_REQUIRED', 'instruct settlement');
  if (actor.id === draw.requestedBy) {
    throw new DrawError('SOD_REQUESTER_CANNOT_INSTRUCT', 'The requester of a draw cannot instruct its settlement');
  }
  if (draw.approvals.some((a) => a.actorId === actor.id)) {
    throw new DrawError('SOD_APPROVER_CANNOT_INSTRUCT', 'An approver of this draw cannot instruct its settlement');
  }
  requireRole(actor, pack.instructorRoles, 'instruct settlement');
}
