import { test } from 'node:test';
import assert from 'node:assert/strict';
import { as, draft, rejects, toApproved, world } from './helpers.js';
import { usd } from '../src/money.js';
import { AuditLog } from '../src/audit.js';

test('happy path DRAFT → CLOSED with a live hash-chained audit', () => {
  const w = world();
  const d = draft(w, { amount: 100_000 });

  let draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'UNDER_REVIEW');
  assert.equal(draw.policyVersion, 'policy-2026.09.26-construction');
  assert.equal(draw.manifest.length, 3);
  assert.equal(draw.evaluation.outcome, 'PASS');
  assert.equal(draw.evaluation.freshness.score, 1);

  draw = w.engine.approve(as.risk, d.id);
  assert.equal(draw.state, 'APPROVED');
  assert.match(draw.bindingHash, /^[0-9a-f]{64}$/);

  draw = w.engine.instructSettlement(as.treasury, d.id);
  assert.equal(draw.state, 'SETTLEMENT_INSTRUCTED');
  assert.equal(draw.instruction.amountMinor, usd(90_000));

  draw = w.engine.recordPartnerConfirmation(as.partner, d.id, {
    instructionId: draw.instruction.id,
    partnerRef: 'WIRE-20260926-0001',
    amountMinor: draw.instruction.amountMinor,
    payeeAccountFingerprint: draw.instruction.payeeAccountFingerprint,
    settledAt: w.clock.now().toISOString(),
  });
  assert.equal(draw.state, 'RECONCILED');

  draw = w.engine.close(as.treasury, d.id);
  assert.equal(draw.state, 'CLOSED');

  const deal = w.engine.getDeal(as.admin, w.deal.id);
  assert.equal(deal.drawnGrossMinor, usd(100_000));
  assert.equal(deal.budgetLines.find((b) => b.code === 'FRAMING').drawnMinor, usd(100_000));

  const trail = w.engine.auditTrail(as.risk, { drawId: d.id });
  const path = trail.filter((e) => e.type === 'DRAW_STATE_CHANGED').map((e) => e.to);
  assert.deepEqual(path, [
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'SETTLEMENT_INSTRUCTED',
    'SETTLEMENT_CONFIRMED',
    'RECONCILED',
    'CLOSED',
  ]);
  const v = w.engine.verifyAudit(as.risk);
  assert.equal(v.ok, true);
  assert.ok(v.length > trail.length); // deal + payee events are chained too
});

test('audit verify() detects tampering', () => {
  const w = world();
  toApproved(w);
  const events = w.engine.auditTrail(as.risk).map((e) => structuredClone(e));
  assert.equal(AuditLog.verifyEvents(events).ok, true);
  events[2].actorId = 'usr_someone_else';
  const v = AuditLog.verifyEvents(events);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
  assert.throws(() => {
    'use strict';
    w.engine.auditTrail(as.risk)[0].actorId = 'x';
  }, TypeError);
});

test('missing inspection at submit → HELD, desk names the document and how to clear it', () => {
  const w = world();
  const d = draft(w, { amount: 120_000, evidence: ['INVOICE', 'LIEN_WAIVER', 'SITE_PHOTOS'] });
  const draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'HELD');
  assert.equal(draw.evaluation.outcome, 'HOLD');

  const desk = w.engine.desk(as.risk, d.id);
  assert.equal(desk.holds.length, 1);
  const [hold] = desk.holds;
  assert.equal(hold.ruleId, 'EVIDENCE.REQUIRED.INSPECTION_REPORT');
  assert.equal(hold.title, 'Missing inspection report');
  assert.match(hold.why, /inspection report/);
  assert.match(hold.clearsWhen, /attaches an? inspection report.*resubmits/);
  assert.equal(hold.scope, 'draw');
  assert.equal(hold.blocked, '$120,000.00');
  assert.equal(desk.headline, 'HELD: 1 hold, $120,000.00 blocked');

  // Freshness is scored on required types; the optional SITE_PHOTOS does not count.
  assert.equal(draw.evaluation.freshness.score, 2 / 3);

  // Clearing: attach the inspection and resubmit.
  const [inspection] = [{ type: 'INSPECTION_REPORT', content: 'insp', collectedAt: w.clock.now().toISOString() }];
  w.engine.attachEvidence(as.sponsor, d.id, inspection);
  assert.equal(w.engine.submit(as.sponsor, d.id).state, 'UNDER_REVIEW');
});

test('stale required evidence holds; the policy pack stays locked from first submit', () => {
  const w = world();
  const d = draft(w, { evidence: ['INVOICE', 'LIEN_WAIVER'] });
  w.engine.attachEvidence(as.sponsor, d.id, {
    type: 'INSPECTION_REPORT',
    content: 'old inspection',
    collectedAt: new Date(w.clock.now().getTime() - 45 * 86_400_000).toISOString(),
  });
  const draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'HELD');
  assert.deepEqual(
    draw.evaluation.reasons.map((r) => r.ruleId),
    ['EVIDENCE.FRESHNESS.INSPECTION_REPORT'],
  );
  const stale = draw.evidence.find((e) => e.type === 'INSPECTION_REPORT');
  w.engine.supersedeEvidence(as.sponsor, d.id, stale.id, { content: 'new inspection', collectedAt: w.clock.now().toISOString() });
  const again = w.engine.submit(as.sponsor, d.id);
  assert.equal(again.state, 'UNDER_REVIEW');
  assert.equal(again.policyVersion, draw.policyVersion);
  assert.equal(again.evidence.length, 4); // superseded item is kept, not deleted
  assert.equal(again.manifest.length, 3);
});

test('evidence is hashed server-side on ingest and frozen at submit', () => {
  const w = world();
  const d = draft(w);
  const draw = w.engine.submit(as.sponsor, d.id);
  for (const e of draw.evidence) assert.match(e.sha256, /^[0-9a-f]{64}$/);
  rejects(
    () => w.engine.attachEvidence(as.sponsor, d.id, { type: 'INVOICE', content: 'late', collectedAt: w.clock.now() }),
    'EVIDENCE_LOCKED',
  );
});

test('confirmation amount mismatch → RECONCILIATION_EXCEPTION; CLOSED is illegal', () => {
  const w = world();
  const d = toApproved(w);
  const instructed = w.engine.instructSettlement(as.treasury, d.id);
  const draw = w.engine.recordPartnerConfirmation(as.partner, d.id, {
    instructionId: instructed.instruction.id,
    partnerRef: 'WIRE-X',
    amountMinor: instructed.instruction.amountMinor - 100n,
    payeeAccountFingerprint: instructed.instruction.payeeAccountFingerprint,
    settledAt: w.clock.now().toISOString(),
  });
  assert.equal(draw.state, 'RECONCILIATION_EXCEPTION');
  assert.deepEqual(draw.reconciliation.breaks.map((b) => b.ruleId), ['RECON.AMOUNT_MISMATCH']);
  rejects(() => w.engine.close(as.treasury, d.id), 'ILLEGAL_TRANSITION');

  const desk = w.engine.desk(as.treasury, d.id);
  assert.equal(desk.holds[0].title, 'Partner confirmed a different amount');
  assert.equal(desk.holds[0].blocked, '$90,000.00');

  // A corrected confirmation reconciles; only then can it close.
  const fixed = w.engine.recordPartnerConfirmation(as.partner, d.id, {
    instructionId: instructed.instruction.id,
    partnerRef: 'WIRE-X-CORR',
    amountMinor: instructed.instruction.amountMinor,
    payeeAccountFingerprint: instructed.instruction.payeeAccountFingerprint,
    settledAt: w.clock.now().toISOString(),
  });
  assert.equal(fixed.state, 'RECONCILED');
  assert.equal(w.engine.close(as.treasury, d.id).state, 'CLOSED');
});

test('CSV dual-entry needs two different people keying the same row', () => {
  const w = world();
  const d = toApproved(w);
  const { instruction } = w.engine.instructSettlement(as.treasury, d.id);
  const row = {
    instructionId: instruction.id,
    partnerRef: 'CSV-77',
    amountMinor: instruction.amountMinor.toString(),
    payeeAccountFingerprint: instruction.payeeAccountFingerprint,
    settledAt: w.clock.now().toISOString(),
  };
  assert.equal(w.engine.enterCsvConfirmation(as.treasury, d.id, row).state, 'SETTLEMENT_INSTRUCTED');
  rejects(() => w.engine.enterCsvConfirmation(as.treasury, d.id, row), 'SOD_CSV_SAME_PERSON');
  rejects(() => w.engine.enterCsvConfirmation(as.treasury2, d.id, { ...row, amountMinor: '1' }), 'CSV_ENTRY_MISMATCH');
  // Mismatch discards both entries; start over.
  w.engine.enterCsvConfirmation(as.treasury2, d.id, row);
  const draw = w.engine.enterCsvConfirmation(as.admin, d.id, row);
  assert.equal(draw.state, 'RECONCILED');
  assert.deepEqual(draw.confirmation.recordedBy, ['usr_treasury_mo', 'usr_admin_jo']);
});

test('over-budget line → REQUIRES_INFORMATION; amend and resubmit', () => {
  const w = world();
  const d = draft(w, { amount: 450_000, code: 'SITEWORK' });
  const draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'REQUIRES_INFORMATION');
  const desk = w.engine.desk(as.risk, d.id);
  const hold = desk.holds.find((h) => h.ruleId === 'BUDGET.LINE_EXCEEDED');
  assert.equal(hold.scope, 'line:SITEWORK');
  assert.equal(hold.blocked, '$50,000.00');
  w.engine.amendDraw(as.sponsor, d.id, { lines: [{ budgetCode: 'SITEWORK', amountMinor: usd(200_000) }] });
  assert.equal(w.engine.submit(as.sponsor, d.id).state, 'UNDER_REVIEW');
});

test('payee cooling and stale sanctions hold the draw', () => {
  const w = world();
  w.engine.changePayeeAccount(as.admin, w.deal.id, w.payee.id, { accountFingerprint: 'acct:ridgeline:****9001' });
  w.clock.advance(30 * 86_400_000); // sanctions now 35 days old, and evidence re-dated below
  const d = draft(w);
  const draw = w.engine.submit(as.sponsor, d.id);
  assert.equal(draw.state, 'HELD');
  assert.deepEqual(draw.evaluation.reasons.map((r) => r.ruleId).sort(), ['PAYEE.SANCTIONS_AGE']);

  const w2 = world();
  w2.engine.changePayeeAccount(as.admin, w2.deal.id, w2.payee.id, { accountFingerprint: 'acct:ridgeline:****9001' });
  const d2 = draft(w2);
  const held = w2.engine.submit(as.sponsor, d2.id);
  assert.deepEqual(held.evaluation.reasons.map((r) => r.ruleId), ['PAYEE.COOLING']);
  w2.clock.advance(25 * 3_600_000);
  assert.equal(w2.engine.submit(as.sponsor, d2.id).state, 'UNDER_REVIEW');
});

test('illegal transitions are refused', () => {
  const w = world();
  const d = draft(w);
  rejects(() => w.engine.approve(as.risk, d.id), 'ILLEGAL_TRANSITION');
  rejects(() => w.engine.instructSettlement(as.treasury, d.id), 'ILLEGAL_TRANSITION');
  rejects(() => w.engine.close(as.treasury, d.id), 'ILLEGAL_TRANSITION');
});
