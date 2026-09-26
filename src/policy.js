import { DrawError } from './errors.js';
import { deepFreeze } from './util.js';
import { formatUsd } from './money.js';

export const CONSTRUCTION_V0 = deepFreeze({
  version: 'policy-2026.09.26-construction',
  product: 'construction',
  requiredEvidence: ['INVOICE', 'INSPECTION_REPORT', 'LIEN_WAIVER'],
  evidenceMaxAgeDays: { INVOICE: 60, INSPECTION_REPORT: 30, LIEN_WAIVER: 45 },
  approverRoles: ['RiskOwner', 'Underwriter', 'LenderAdmin'],
  instructorRoles: ['TreasuryOwner'],
  approvalsBelowThreshold: 1,
  approvalsAtOrAboveThreshold: 2,
  sanctionsMaxAgeDays: 30,
  payeeCoolingHours: 24,
});

export const POLICY_PACKS = new Map([[CONSTRUCTION_V0.version, CONSTRUCTION_V0]]);

export function getPolicyPack(packs, version) {
  const pack = packs.get(version);
  if (!pack) throw new DrawError('POLICY_PACK_UNKNOWN', `No policy pack ${version}`);
  return pack;
}

export const EVIDENCE_LABEL = Object.freeze({
  INVOICE: 'invoice',
  INSPECTION_REPORT: 'inspection report',
  LIEN_WAIVER: 'lien waiver',
});
const label = (t) => EVIDENCE_LABEL[t] ?? t.toLowerCase().replaceAll('_', ' ');
const withArticle = (t) => `${/^[aeiou]/.test(label(t)) ? 'an' : 'a'} ${label(t)}`;

export const OUTCOME_RANK = Object.freeze({ PASS: 0, REVIEW_REQUIRED: 1, HOLD: 2, FAIL: 3 });

/**
 * Freshness is scored on the pack's REQUIRED types only. Optional extras
 * (photos, change orders, …) neither help nor hurt the score.
 */
export function scoreFreshness(pack, manifest, now) {
  const perType = pack.requiredEvidence.map((type) => {
    const newest = manifest
      .filter((e) => e.type === type)
      .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))[0];
    if (!newest) return { type, present: false, fresh: false, ageDays: null };
    const ageDays = Math.floor((now.getTime() - Date.parse(newest.collectedAt)) / 86_400_000);
    return { type, present: true, fresh: ageDays <= pack.evidenceMaxAgeDays[type], ageDays, evidenceId: newest.id };
  });
  const fresh = perType.filter((t) => t.fresh).length;
  return { score: fresh / pack.requiredEvidence.length, perType };
}

/**
 * Evaluate a draw against its locked pack. Pure: no I/O, no mutation.
 * Returns PASS | HOLD | FAIL | REVIEW_REQUIRED plus desk-readable reasons.
 */
export function evaluatePolicy({ pack, deal, draw, manifest, controls, now }) {
  const reasons = [];
  const gross = controls.grossMinor;
  const push = (r) => reasons.push({ scope: 'draw', blockedMinor: gross, ...r });

  const freshness = scoreFreshness(pack, manifest, now);
  for (const t of freshness.perType) {
    if (!t.present) {
      push({
        ruleId: `EVIDENCE.REQUIRED.${t.type}`,
        outcome: 'HOLD',
        title: `Missing ${label(t.type)}`,
        why: `${pack.version} requires ${withArticle(t.type)} on every ${pack.product} draw. None is in this draw's frozen evidence manifest.`,
        clearsWhen: `The sponsor attaches ${withArticle(t.type)} dated within ${pack.evidenceMaxAgeDays[t.type]} days and resubmits.`,
      });
    } else if (!t.fresh) {
      push({
        ruleId: `EVIDENCE.FRESHNESS.${t.type}`,
        outcome: 'HOLD',
        title: `Stale ${label(t.type)}`,
        why: `The newest ${label(t.type)} is ${t.ageDays} days old; the limit is ${pack.evidenceMaxAgeDays[t.type]} days.`,
        clearsWhen: `The sponsor supersedes it with ${withArticle(t.type)} dated within ${pack.evidenceMaxAgeDays[t.type]} days and resubmits.`,
      });
    }
  }

  for (const line of controls.lines) {
    if (!line.known) {
      reasons.push({
        ruleId: 'BUDGET.LINE_UNKNOWN',
        outcome: 'FAIL',
        scope: `line:${line.code}`,
        blockedMinor: line.requestedMinor,
        title: `Budget line ${line.code} does not exist`,
        why: `Deal ${deal.name} has no budget line ${line.code}.`,
        clearsWhen: 'The sponsor moves the amount to an existing budget line and resubmits.',
      });
    } else if (!line.withinBudget) {
      reasons.push({
        ruleId: 'BUDGET.LINE_EXCEEDED',
        outcome: 'FAIL',
        scope: `line:${line.code}`,
        blockedMinor: line.requestedMinor - (line.remainingMinor > 0n ? line.remainingMinor : 0n),
        title: `Budget line ${line.code} is over budget`,
        why: `Requested ${formatUsd(line.requestedMinor)}; only ${formatUsd(line.remainingMinor)} remains on ${line.code}.`,
        clearsWhen: `The sponsor reduces ${line.code} to ${formatUsd(line.remainingMinor)} or less, or the lender approves a budget reallocation, then resubmits.`,
      });
    }
  }

  if (!controls.withinCommitment) {
    push({
      ruleId: 'COVENANT.COMMITMENT_CAP',
      outcome: 'FAIL',
      scope: 'deal',
      title: 'Draw exceeds remaining loan commitment',
      why: `Requested ${formatUsd(gross)}; commitment headroom is ${formatUsd(controls.commitmentHeadroomMinor)}.`,
      clearsWhen: 'The sponsor reduces the draw to the remaining commitment, or the facility is amended.',
    });
  }
  if (controls.matured) {
    push({
      ruleId: 'COVENANT.MATURITY',
      outcome: 'FAIL',
      scope: 'deal',
      title: 'Loan has matured',
      why: `Deal ${deal.name} matured on ${deal.maturityDate}. No draws fund after maturity.`,
      clearsWhen: 'The lender records a maturity extension on the deal.',
    });
  }

  if (!controls.payeeKnown) {
    push({
      ruleId: 'PAYEE.UNKNOWN',
      outcome: 'FAIL',
      scope: 'payee',
      title: 'Payee is not on the deal',
      why: `Payee ${draw.payeeId} is not registered on deal ${deal.name}.`,
      clearsWhen: 'The lender registers the payee, or the sponsor selects a registered payee.',
    });
  } else {
    if (!controls.payeeCoolingOk) {
      push({
        ruleId: 'PAYEE.COOLING',
        outcome: 'HOLD',
        scope: 'payee',
        title: 'Payee account is in its cooling period',
        why: `The payee's bank account was set ${controls.payeeAccountAgeHours}h ago; policy requires ${pack.payeeCoolingHours}h before funds can go to it.`,
        clearsWhen: `The ${pack.payeeCoolingHours}h cooling window has elapsed and the sponsor resubmits.`,
      });
    }
    if (!controls.sanctionsOk) {
      push({
        ruleId: 'PAYEE.SANCTIONS_AGE',
        outcome: 'HOLD',
        scope: 'payee',
        title: controls.sanctionsAgeDays === null ? 'Payee has no sanctions screen' : 'Payee sanctions screen is stale',
        why:
          controls.sanctionsAgeDays === null
            ? 'No sanctions screening is on file for this payee.'
            : `Last screen was ${controls.sanctionsAgeDays} days ago; limit is ${pack.sanctionsMaxAgeDays} days.`,
        clearsWhen: `Compliance records a sanctions screen dated within ${pack.sanctionsMaxAgeDays} days.`,
      });
    }
  }

  if (controls.requiredApprovals > 1) {
    reasons.push({
      ruleId: 'APPROVAL.DUAL_CONTROL',
      outcome: 'REVIEW_REQUIRED',
      scope: 'draw',
      blockedMinor: 0n,
      title: 'Dual control required',
      why: `${formatUsd(gross)} is at or above the deal's dual-control threshold of ${formatUsd(deal.dualControlThresholdMinor)}.`,
      clearsWhen: `${controls.requiredApprovals} distinct approvers approve the same binding.`,
    });
  }

  const outcome = reasons.reduce(
    (worst, r) => (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[worst] ? r.outcome : worst),
    'PASS',
  );
  return { outcome, reasons, freshness, policyVersion: pack.version };
}
