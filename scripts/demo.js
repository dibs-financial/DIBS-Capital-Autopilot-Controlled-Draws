#!/usr/bin/env node
// Walks two draws through the engine and prints what a credit officer sees.
import { ControlledDrawEngine } from '../src/engine.js';
import { Clock } from '../src/clock.js';
import { ACTORS, seedDeal, sessionFor, standardEvidence } from '../src/seed.js';
import { formatUsd, usd } from '../src/money.js';

const clock = new Clock();
const engine = new ControlledDrawEngine({ now: clock.now });
const { deal, payee } = seedDeal(engine, clock);
const as = Object.fromEntries(Object.entries(ACTORS).map(([k, a]) => [k, sessionFor(a)]));

const step = (label, draw) => console.log(`  ${label.padEnd(36)} → ${draw.state}`);
const printDesk = (card) => {
  console.log(`\n  DESK  ${card.deal} · ${card.headline}`);
  for (const h of card.holds) {
    console.log(`   ■ ${h.title}  [${h.ruleId} · ${h.scope} · ${h.blocked}]`);
    console.log(`     why:          ${h.why}`);
    console.log(`     clears when:  ${h.clearsWhen}`);
  }
  for (const n of card.notes) console.log(`   ○ ${n.title}: ${n.why}`);
};

console.log('\nDIBS Capital Autopilot — controlled draws (demo, in-memory)\n');

// ── 1. A draw missing its inspection report.
console.log('Draw A: $120,000 framing, inspection report missing');
const a = engine.createDraw(as.sponsor, {
  dealId: deal.id,
  payeeId: payee.id,
  lines: [{ budgetCode: 'FRAMING', amountMinor: usd(120_000) }],
});
for (const e of standardEvidence(clock.now(), ['INVOICE', 'LIEN_WAIVER'])) engine.attachEvidence(as.sponsor, a.id, e);
step('sponsor submits', engine.submit(as.sponsor, a.id));
printDesk(engine.desk(as.risk, a.id));
engine.attachEvidence(as.sponsor, a.id, standardEvidence(clock.now(), ['INSPECTION_REPORT'])[0]);
console.log('');
step('sponsor adds inspection, resubmits', engine.submit(as.sponsor, a.id));

// ── 2. A $300,000 draw through dual control to close.
console.log('\nDraw B: $300,000 MEP, full evidence, dual control');
const b = engine.createDraw(as.sponsor, {
  dealId: deal.id,
  payeeId: payee.id,
  lines: [{ budgetCode: 'MEP', amountMinor: usd(300_000) }],
});
for (const e of standardEvidence(clock.now())) engine.attachEvidence(as.sponsor, b.id, e);
step('sponsor submits', engine.submit(as.sponsor, b.id));
printDesk(engine.desk(as.risk, b.id));
try {
  engine.approve(as.sponsor, b.id);
} catch (e) {
  console.log(`\n  ${'sponsor tries to approve'.padEnd(36)} ✗ ${e.code}`);
}
step('risk owner approves (1 of 2)', engine.approve(as.risk, b.id));
let draw = engine.approve(as.underwriter, b.id);
step('underwriter approves (2 of 2)', draw);
try {
  engine.instructSettlement(as.risk, b.id);
} catch (e) {
  console.log(`  ${'risk owner tries to instruct'.padEnd(36)} ✗ ${e.code}`);
}
draw = engine.instructSettlement(as.treasury, b.id);
step(`treasury instructs ${formatUsd(draw.instruction.amountMinor)}`, draw);
draw = engine.recordPartnerConfirmation(as.partner, b.id, {
  instructionId: draw.instruction.id,
  partnerRef: 'WIRE-20260926-0042',
  amountMinor: draw.instruction.amountMinor,
  payeeAccountFingerprint: draw.instruction.payeeAccountFingerprint,
  settledAt: clock.now().toISOString(),
});
step('partner confirms, recon runs', draw);
step('treasury closes', engine.close(as.treasury, b.id));

const c = draw.controls;
console.log(`\n  gross ${formatUsd(c.grossMinor)} · retainage ${formatUsd(c.retainageMinor)} · paid ${formatUsd(c.eligibleMinor)}`);

const v = engine.verifyAudit(as.risk);
console.log(`\nAudit chain: ${v.ok ? 'VERIFIED' : 'BROKEN'} · ${v.length} events · head ${v.head?.slice(0, 16)}…\n`);
if (!v.ok) process.exitCode = 1;
