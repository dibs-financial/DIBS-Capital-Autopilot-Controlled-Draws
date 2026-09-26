import { ceilBps, sum } from './money.js';
import { DAY_MS, HOUR_MS } from './util.js';

/**
 * Server-side approval controls. Nothing here is ever read from a client.
 * Eligible = min(requested, remaining budget) per line, less retainage.
 */
export function computeControls({ pack, deal, draw, now }) {
  const lines = draw.lines.map((l) => {
    const bl = deal.budgetLines.find((b) => b.code === l.budgetCode);
    if (!bl) return { code: l.budgetCode, requestedMinor: l.amountMinor, known: false, withinBudget: false, fundableMinor: 0n };
    const remainingMinor = bl.budgetMinor - bl.drawnMinor;
    const fundableMinor = l.amountMinor <= remainingMinor ? l.amountMinor : remainingMinor > 0n ? remainingMinor : 0n;
    return {
      code: l.budgetCode,
      requestedMinor: l.amountMinor,
      remainingMinor,
      known: true,
      withinBudget: l.amountMinor <= remainingMinor,
      fundableMinor,
    };
  });

  const grossMinor = sum(lines.map((l) => l.requestedMinor));
  const fundableMinor = sum(lines.map((l) => l.fundableMinor));
  const retainageMinor = ceilBps(fundableMinor, deal.retainageBps);
  const eligibleMinor = fundableMinor - retainageMinor;

  const commitmentHeadroomMinor = deal.commitmentMinor - deal.drawnGrossMinor;
  const payee = deal.payees.find((p) => p.id === draw.payeeId);
  const payeeAccountAgeHours = payee ? Math.floor((now.getTime() - Date.parse(payee.accountSetAt)) / HOUR_MS) : null;
  const sanctionsAgeDays = payee?.sanctionsScreenedAt
    ? Math.floor((now.getTime() - Date.parse(payee.sanctionsScreenedAt)) / DAY_MS)
    : null;

  return {
    lines,
    grossMinor,
    fundableMinor,
    retainageBps: deal.retainageBps,
    retainageMinor,
    eligibleMinor,
    commitmentHeadroomMinor,
    withinCommitment: grossMinor <= commitmentHeadroomMinor,
    matured: deal.maturityDate ? now.getTime() > Date.parse(deal.maturityDate) : false,
    payeeKnown: Boolean(payee),
    payeeAccountFingerprint: payee?.accountFingerprint ?? null,
    payeeAccountAgeHours,
    payeeCoolingOk: payee ? payeeAccountAgeHours >= pack.payeeCoolingHours : false,
    sanctionsAgeDays,
    sanctionsOk: sanctionsAgeDays !== null && sanctionsAgeDays <= pack.sanctionsMaxAgeDays,
    requiredApprovals:
      grossMinor >= deal.dualControlThresholdMinor ? pack.approvalsAtOrAboveThreshold : pack.approvalsBelowThreshold,
  };
}
