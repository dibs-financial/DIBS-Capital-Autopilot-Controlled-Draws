import assert from 'node:assert/strict';
import { ControlledDrawEngine } from '../src/engine.js';
import { Clock } from '../src/clock.js';
import { ACTORS, seedDeal, sessionFor, standardEvidence } from '../src/seed.js';
import { usd } from '../src/money.js';

export const as = Object.fromEntries(Object.entries(ACTORS).map(([k, a]) => [k, sessionFor(a)]));

export function world() {
  const clock = new Clock();
  const engine = new ControlledDrawEngine({ now: clock.now });
  const seeded = seedDeal(engine, clock);
  return { engine, clock, ...seeded };
}

/** Create a draw, attach evidence (default: all required), return it in DRAFT. */
export function draft(w, { amount = 100_000, code = 'FRAMING', evidence, sponsor = as.sponsor } = {}) {
  const draw = w.engine.createDraw(sponsor, {
    dealId: w.deal.id,
    payeeId: w.payee.id,
    lines: [{ budgetCode: code, amountMinor: usd(amount) }],
  });
  for (const item of standardEvidence(w.clock.now(), evidence)) w.engine.attachEvidence(sponsor, draw.id, item);
  return draw;
}

export function toApproved(w, opts = {}) {
  const d = draft(w, opts);
  w.engine.submit(opts.sponsor ?? as.sponsor, d.id);
  return w.engine.approve(as.risk, d.id);
}

export function rejects(fn, code) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}
