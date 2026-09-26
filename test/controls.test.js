import { test } from 'node:test';
import assert from 'node:assert/strict';
import { as, draft, rejects, toApproved, world } from './helpers.js';
import { usd, parseMinor } from '../src/money.js';

test('self-approval blocked', () => {
  const w = world();
  const d = draft(w, { sponsor: as.sponsorRisk });
  w.engine.submit(as.sponsorRisk, d.id);
  rejects(() => w.engine.approve(as.sponsorRisk, d.id), 'SOD_SELF_APPROVAL');
});

test('service-account approval blocked', () => {
  const w = world();
  const d = draft(w);
  w.engine.submit(as.sponsor, d.id);
  rejects(() => w.engine.approve(as.riskBot, d.id), 'SERVICE_ACCOUNT_CANNOT_APPROVE');
});

test('non-approver role cannot approve', () => {
  const w = world();
  const d = draft(w);
  w.engine.submit(as.sponsor, d.id);
  rejects(() => w.engine.approve(as.treasury, d.id), 'ROLE_REQUIRED');
});

test('cross-tenant access denied', () => {
  const w = world();
  const d = draft(w);
  rejects(() => w.engine.getDraw(as.globexSponsor, d.id), 'NOT_FOUND');
  rejects(() => w.engine.desk(as.globexSponsor, d.id), 'NOT_FOUND');
  rejects(() => w.engine.submit(as.globexSponsor, d.id), 'NOT_FOUND');
  rejects(
    () => w.engine.createDraw(as.globexSponsor, { dealId: w.deal.id, payeeId: w.payee.id, lines: [{ budgetCode: 'MEP', amountMinor: 1n }] }),
    'NOT_FOUND',
  );
  assert.equal(w.engine.listDraws(as.globexSponsor).length, 0);
  assert.ok(w.engine.auditTrail(as.globexSponsor).every((e) => e.tenantId === 'tenant-globex-credit'));
});

test('client-supplied tenantId rejected', () => {
  const w = world();
  rejects(
    () =>
      w.engine.createDraw(as.sponsor, {
        tenantId: 'tenant-globex-credit',
        dealId: w.deal.id,
        payeeId: w.payee.id,
        lines: [{ budgetCode: 'MEP', amountMinor: usd(1) }],
      }),
    'CLIENT_TENANT_ID_REJECTED',
  );
  rejects(
    () =>
      w.engine.createDraw(as.sponsor, {
        dealId: w.deal.id,
        payeeId: w.payee.id,
        lines: [{ budgetCode: 'MEP', amountMinor: usd(1), tenant_id: 'x' }],
      }),
    'CLIENT_TENANT_ID_REJECTED',
  );
  rejects(() => w.engine.listDraws(as.sponsor, { tenantId: 'x' }), 'CLIENT_TENANT_ID_REJECTED');
});

test('dual control: $300,000 needs two distinct approvers', () => {
  const w = world();
  const d = draft(w, { amount: 300_000 });
  let draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'UNDER_REVIEW');
  assert.equal(draw.controls.requiredApprovals, 2);
  assert.equal(w.engine.desk(as.risk, d.id).notes[0].ruleId, 'APPROVAL.DUAL_CONTROL');

  draw = w.engine.approve(as.risk, d.id);
  assert.equal(draw.state, 'UNDER_REVIEW');
  assert.equal(draw.approvals.length, 1);
  rejects(() => w.engine.approve(as.risk, d.id), 'SOD_DUPLICATE_APPROVER');

  draw = w.engine.approve(as.underwriter, d.id);
  assert.equal(draw.state, 'APPROVED');
  assert.deepEqual(draw.approvals.map((a) => a.actorId), ['usr_risk_sam', 'usr_uw_priya']);
});

test('below threshold needs one approval', () => {
  const w = world();
  const d = draft(w, { amount: 249_999 });
  w.engine.submit(as.sponsor, d.id);
  assert.equal(w.engine.approve(as.underwriter, d.id).state, 'APPROVED');
});

test('approver cannot instruct settlement', () => {
  const w = world();
  const d = draft(w);
  w.engine.submit(as.sponsor, d.id);
  assert.equal(w.engine.approve(as.dualHat, d.id).state, 'APPROVED');
  rejects(() => w.engine.instructSettlement(as.dualHat, d.id), 'SOD_APPROVER_CANNOT_INSTRUCT');
  rejects(() => w.engine.instructSettlement(as.risk, d.id), 'ROLE_REQUIRED');
  rejects(() => w.engine.instructSettlement(as.sponsor, d.id), 'SOD_REQUESTER_CANNOT_INSTRUCT');
  assert.equal(w.engine.instructSettlement(as.treasury, d.id).state, 'SETTLEMENT_INSTRUCTED');
});

test('binding break from APPROVED → UNDER_REVIEW', () => {
  const w = world();

  // 1. Explicit break.
  const a = toApproved(w);
  let draw = w.engine.breakBinding(as.risk, a.id, { reason: 'Inspector flagged framing rework' });
  assert.equal(draw.state, 'UNDER_REVIEW');
  assert.equal(draw.approvals.length, 0);
  assert.equal(draw.bindingHash, null);
  assert.equal(w.engine.desk(as.risk, a.id).holds[0].ruleId, 'BINDING.BROKEN');

  // 2. Evidence superseded after approval.
  const b = toApproved(w);
  const invoice = b.evidence.find((e) => e.type === 'INVOICE');
  w.engine.supersedeEvidence(as.sponsor, b.id, invoice.id, { content: 'revised invoice', collectedAt: w.clock.now().toISOString() });
  draw = w.engine.getDraw(as.risk, b.id);
  assert.equal(draw.state, 'UNDER_REVIEW');
  assert.notEqual(draw.manifestHash, b.manifestHash);

  // 3. Payee account changed after approval.
  const c = toApproved(w);
  w.engine.changePayeeAccount(as.admin, w.deal.id, w.payee.id, { accountFingerprint: 'acct:ridgeline:****0000' });
  assert.equal(w.engine.getDraw(as.risk, c.id).state, 'UNDER_REVIEW');
  // Re-approval re-checks controls: new account is in cooling, so it holds.
  assert.equal(w.engine.approve(as.risk, c.id).state, 'HELD');
});

test('eligible amount is computed from budget + retainage, not from the approver', () => {
  const w = world();
  const d = draft(w, { amount: 100_000 });
  w.engine.submit(as.sponsor, d.id);
  // Extra arguments are never read.
  const draw = w.engine.approve(as.risk, d.id, {
    eligibleMinor: usd(100_000),
    controls: { retainageBps: 0, sanctionsOk: true, requiredApprovals: 0 },
  });
  assert.equal(draw.state, 'APPROVED');
  assert.equal(draw.controls.grossMinor, usd(100_000));
  assert.equal(draw.controls.retainageMinor, usd(10_000));
  assert.equal(draw.controls.eligibleMinor, usd(90_000));
  const instructed = w.engine.instructSettlement(as.treasury, d.id);
  assert.equal(instructed.instruction.amountMinor, usd(90_000));
});

test('money is integer minor units; floats are refused', () => {
  assert.equal(parseMinor('12345'), 12345n);
  rejects(() => parseMinor(123.45), 'VALIDATION');
  rejects(() => parseMinor('123.45'), 'VALIDATION');
  rejects(() => parseMinor(-1n), 'VALIDATION');
  const w = world();
  rejects(
    () => w.engine.createDraw(as.sponsor, { dealId: w.deal.id, payeeId: w.payee.id, lines: [{ budgetCode: 'MEP', amountMinor: 1000.5 }] }),
    'VALIDATION',
  );
});
