import { randomUUID } from 'node:crypto';
import { AuditLog } from './audit.js';
import { computeControls } from './controls.js';
import { DrawError } from './errors.js';
import { freezeManifest, ingestEvidence } from './evidence.js';
import { formatUsd, parseMinor } from './money.js';
import { CONSTRUCTION_V0, POLICY_PACKS, evaluatePolicy, getPolicyPack } from './policy.js';
import { ROLES, assertCanApprove, assertCanInstruct, requireHuman, requireRole } from './sod.js';
import { S, assertTransition } from './states.js';
import { hashOf, toDate } from './util.js';

const RECONCILER = 'system:reconciler';
const SUPERSEDE_OPEN = new Set([S.DRAFT, S.HELD, S.REQUIRES_INFORMATION, S.UNDER_REVIEW, S.APPROVED]);
const ATTACH_OPEN = new Set([S.DRAFT, S.HELD, S.REQUIRES_INFORMATION]);
const CONFIRM_OPEN = new Set([S.SETTLEMENT_INSTRUCTED, S.RECONCILIATION_EXCEPTION]);

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const snapshot = (obj) => structuredClone(obj);

/** A client never names its tenant. The key's presence, at any depth, is a hard error. */
export function rejectClientTenant(input, path = 'input') {
  if (input === null || typeof input !== 'object' || input instanceof Uint8Array) return;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'tenantId' || key === 'tenant_id') {
      throw new DrawError('CLIENT_TENANT_ID_REJECTED', `${path}.${key} is not accepted; tenant comes from the session`);
    }
    rejectClientTenant(value, `${path}.${key}`);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new DrawError('VALIDATION', `${field} is required`);
  return value.trim();
}

function parseLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new DrawError('VALIDATION', 'lines must be a non-empty array');
  const seen = new Set();
  return lines.map((l, i) => {
    const budgetCode = requireString(l?.budgetCode, `lines[${i}].budgetCode`);
    if (seen.has(budgetCode)) throw new DrawError('VALIDATION', `budget line ${budgetCode} appears twice`);
    seen.add(budgetCode);
    const amountMinor = parseMinor(l.amountMinor, `lines[${i}].amountMinor`);
    if (amountMinor === 0n) throw new DrawError('VALIDATION', `lines[${i}].amountMinor must be positive`);
    return { budgetCode, amountMinor };
  });
}

function parseDate(value, field) {
  try {
    return toDate(value, field);
  } catch (e) {
    throw new DrawError('VALIDATION', e.message);
  }
}

/**
 * The controlled-draw control plane.
 *
 * Every public method takes a session ({ actor }) first. tenant_id is read
 * from session.actor.tenantId and nowhere else. Every mutation appends an
 * audit event first and mutates only if the append succeeded.
 */
export class ControlledDrawEngine {
  #spaces = new Map();
  #audit = new AuditLog();
  #clock;
  #packs;

  constructor({ now = () => new Date(), policyPacks = POLICY_PACKS } = {}) {
    this.#clock = now;
    this.#packs = policyPacks;
  }

  // ───────────────────────────── plumbing

  #now() {
    return toDate(this.#clock(), 'clock');
  }

  #actor(session, ...inputs) {
    const actor = session?.actor;
    if (
      !actor ||
      typeof actor.id !== 'string' ||
      typeof actor.tenantId !== 'string' ||
      !Array.isArray(actor.roles) ||
      (actor.kind !== 'human' && actor.kind !== 'service')
    ) {
      throw new DrawError('UNAUTHENTICATED', 'A session with an authenticated actor is required');
    }
    for (const input of inputs) rejectClientTenant(input);
    return actor;
  }

  #space(tenantId) {
    let space = this.#spaces.get(tenantId);
    if (!space) {
      space = { deals: new Map(), draws: new Map() };
      this.#spaces.set(tenantId, space);
    }
    return space;
  }

  // Cross-tenant lookups and missing ids are indistinguishable on purpose.
  #deal(actor, dealId) {
    const deal = this.#space(actor.tenantId).deals.get(dealId);
    if (!deal) throw new DrawError('NOT_FOUND', `Deal ${dealId} not found`);
    return deal;
  }

  #draw(actor, drawId) {
    const draw = this.#space(actor.tenantId).draws.get(drawId);
    if (!draw) throw new DrawError('NOT_FOUND', `Draw ${drawId} not found`);
    return draw;
  }

  #payee(deal, payeeId) {
    const payee = deal.payees.find((p) => p.id === payeeId);
    if (!payee) throw new DrawError('NOT_FOUND', `Payee ${payeeId} not found`);
    return payee;
  }

  #append(actorOrId, fields) {
    const actorId = typeof actorOrId === 'string' ? actorOrId : actorOrId.id;
    const tenantId = fields.tenantId;
    return this.#audit.append({ ...fields, tenantId, actorId, at: this.#now() });
  }

  #transition(actorOrId, draw, to, data = {}) {
    assertTransition(draw.state, to);
    this.#append(actorOrId, {
      tenantId: draw.tenantId,
      type: 'DRAW_STATE_CHANGED',
      drawId: draw.id,
      dealId: draw.dealId,
      from: draw.state,
      to,
      data,
    });
    draw.state = to;
    draw.updatedAt = this.#now().toISOString();
  }

  #requireRequester(actor, draw, action) {
    if (actor.id !== draw.requestedBy) throw new DrawError('ROLE_REQUIRED', `Only the requester can ${action}`);
  }

  #pack(draw, deal) {
    return getPolicyPack(this.#packs, draw.policyVersion ?? deal.policyVersion);
  }

  #assess(draw, deal, now = this.#now()) {
    const pack = this.#pack(draw, deal);
    const controls = computeControls({ pack, deal, draw, now });
    const evaluation = evaluatePolicy({ pack, deal, draw, manifest: draw.manifest ?? [], controls, now });
    return { pack, controls, evaluation };
  }

  #binding(draw, controls) {
    return hashOf({
      drawId: draw.id,
      tenantId: draw.tenantId,
      dealId: draw.dealId,
      payeeId: draw.payeeId,
      payeeAccountFingerprint: controls.payeeAccountFingerprint,
      lines: draw.lines,
      grossMinor: controls.grossMinor,
      retainageMinor: controls.retainageMinor,
      eligibleMinor: controls.eligibleMinor,
      manifestHash: draw.manifestHash,
      policyVersion: draw.policyVersion,
    });
  }

  #breakBinding(actorOrId, draw, reason) {
    const previous = draw.bindingHash;
    this.#transition(actorOrId, draw, S.UNDER_REVIEW, { reason, previousBindingHash: previous, approvalsVoided: draw.approvals.map((a) => a.actorId) });
    draw.approvals = [];
    draw.bindingHash = null;
    draw.bindingNotice = {
      ruleId: 'BINDING.BROKEN',
      outcome: 'HOLD',
      scope: 'draw',
      blockedMinor: draw.controls?.grossMinor ?? 0n,
      title: 'Approval no longer matches the draw',
      why: `${reason}. The approved binding no longer describes what would be paid, so every approval on it was voided.`,
      clearsWhen: 'The required approvers review and approve the draw as it stands now.',
    };
  }

  #refreezeManifest(actorOrId, draw) {
    const { manifest, manifestHash } = freezeManifest(draw.evidence);
    this.#append(actorOrId, {
      tenantId: draw.tenantId,
      type: 'MANIFEST_FROZEN',
      drawId: draw.id,
      dealId: draw.dealId,
      data: { manifestHash, evidenceIds: manifest.map((m) => m.id) },
    });
    draw.manifest = manifest;
    draw.manifestHash = manifestHash;
  }

  // ───────────────────────────── deals & payees

  createDeal(session, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.LENDER_ADMIN], 'create a deal');
    const name = requireString(input?.name, 'name');
    const commitmentMinor = parseMinor(input.commitmentMinor, 'commitmentMinor');
    const dualControlThresholdMinor = parseMinor(input.dualControlThresholdMinor, 'dualControlThresholdMinor');
    const retainageBps = input.retainageBps ?? 0;
    if (!Number.isInteger(retainageBps) || retainageBps < 0 || retainageBps > 10_000) {
      throw new DrawError('VALIDATION', 'retainageBps must be an integer 0–10000');
    }
    const policyVersion = input.policyVersion ?? CONSTRUCTION_V0.version;
    getPolicyPack(this.#packs, policyVersion);
    const maturityDate = input.maturityDate ? parseDate(input.maturityDate, 'maturityDate').toISOString() : null;
    if (!Array.isArray(input.budgetLines) || input.budgetLines.length === 0) {
      throw new DrawError('VALIDATION', 'budgetLines must be a non-empty array');
    }
    const codes = new Set();
    const budgetLines = input.budgetLines.map((b, i) => {
      const code = requireString(b?.code, `budgetLines[${i}].code`);
      if (codes.has(code)) throw new DrawError('VALIDATION', `budget line ${code} appears twice`);
      codes.add(code);
      return {
        code,
        description: b.description ?? '',
        budgetMinor: parseMinor(b.budgetMinor, `budgetLines[${i}].budgetMinor`),
        drawnMinor: 0n,
      };
    });

    const deal = {
      id: newId('deal'),
      tenantId: actor.tenantId,
      name,
      policyVersion,
      commitmentMinor,
      dualControlThresholdMinor,
      retainageBps,
      maturityDate,
      budgetLines,
      drawnGrossMinor: 0n,
      payees: [],
      createdAt: this.#now().toISOString(),
      createdBy: actor.id,
    };
    this.#append(actor, {
      tenantId: deal.tenantId,
      type: 'DEAL_CREATED',
      dealId: deal.id,
      data: { name, policyVersion, commitmentMinor, dualControlThresholdMinor, retainageBps },
    });
    this.#space(actor.tenantId).deals.set(deal.id, deal);
    return snapshot(deal);
  }

  addPayee(session, dealId, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.LENDER_ADMIN], 'register a payee');
    const deal = this.#deal(actor, dealId);
    const now = this.#now();
    const payee = {
      id: newId('payee'),
      name: requireString(input?.name, 'name'),
      accountFingerprint: requireString(input.accountFingerprint, 'accountFingerprint'),
      accountSetAt: now.toISOString(),
      sanctionsScreenedAt: input.sanctionsScreenedAt ? parseDate(input.sanctionsScreenedAt, 'sanctionsScreenedAt').toISOString() : null,
    };
    this.#append(actor, { tenantId: deal.tenantId, type: 'PAYEE_ADDED', dealId, data: payee });
    deal.payees.push(payee);
    return snapshot(payee);
  }

  /** A new bank account restarts cooling and breaks every approved binding that pays it. */
  changePayeeAccount(session, dealId, payeeId, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.LENDER_ADMIN], 'change a payee account');
    const deal = this.#deal(actor, dealId);
    const payee = this.#payee(deal, payeeId);
    const accountFingerprint = requireString(input?.accountFingerprint, 'accountFingerprint');
    const now = this.#now().toISOString();
    this.#append(actor, {
      tenantId: deal.tenantId,
      type: 'PAYEE_ACCOUNT_CHANGED',
      dealId,
      data: { payeeId, from: payee.accountFingerprint, to: accountFingerprint },
    });
    payee.accountFingerprint = accountFingerprint;
    payee.accountSetAt = now;
    for (const draw of this.#space(actor.tenantId).draws.values()) {
      if (draw.dealId === dealId && draw.payeeId === payeeId && draw.state === S.APPROVED) {
        this.#breakBinding(actor, draw, 'Payee bank account changed after approval');
      }
    }
    return snapshot(payee);
  }

  recordSanctionsScreen(session, dealId, payeeId, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.LENDER_ADMIN, ROLES.RISK_OWNER], 'record a sanctions screen');
    const deal = this.#deal(actor, dealId);
    const payee = this.#payee(deal, payeeId);
    const screenedAt = parseDate(input?.screenedAt, 'screenedAt');
    if (screenedAt > this.#now()) throw new DrawError('VALIDATION', 'screenedAt cannot be in the future');
    this.#append(actor, {
      tenantId: deal.tenantId,
      type: 'SANCTIONS_SCREEN_RECORDED',
      dealId,
      data: { payeeId, screenedAt: screenedAt.toISOString() },
    });
    payee.sanctionsScreenedAt = screenedAt.toISOString();
    return snapshot(payee);
  }

  getDeal(session, dealId) {
    const actor = this.#actor(session);
    return snapshot(this.#deal(actor, dealId));
  }

  // ───────────────────────────── draws

  createDraw(session, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.SPONSOR], 'request a draw');
    const deal = this.#deal(actor, requireString(input?.dealId, 'dealId'));
    const payeeId = requireString(input.payeeId, 'payeeId');
    this.#payee(deal, payeeId);
    const lines = parseLines(input.lines);
    const now = this.#now().toISOString();
    const draw = {
      id: newId('draw'),
      tenantId: actor.tenantId,
      dealId: deal.id,
      payeeId,
      lines,
      state: S.DRAFT,
      requestedBy: actor.id,
      evidence: [],
      manifest: null,
      manifestHash: null,
      policyVersion: null,
      evaluation: null,
      controls: null,
      approvals: [],
      bindingHash: null,
      bindingNotice: null,
      instruction: null,
      csvPending: null,
      confirmation: null,
      reconciliation: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#append(actor, {
      tenantId: draw.tenantId,
      type: 'DRAW_CREATED',
      drawId: draw.id,
      dealId: deal.id,
      to: S.DRAFT,
      data: { payeeId, lines },
    });
    this.#space(actor.tenantId).draws.set(draw.id, draw);
    return snapshot(draw);
  }

  amendDraw(session, drawId, input) {
    const actor = this.#actor(session, input);
    const draw = this.#draw(actor, drawId);
    this.#requireRequester(actor, draw, 'amend a draw');
    if (draw.state !== S.DRAFT && draw.state !== S.REQUIRES_INFORMATION) {
      throw new DrawError('ILLEGAL_TRANSITION', `A draw in ${draw.state} cannot be amended`);
    }
    const deal = this.#deal(actor, draw.dealId);
    const lines = input?.lines !== undefined ? parseLines(input.lines) : draw.lines;
    const payeeId = input?.payeeId !== undefined ? requireString(input.payeeId, 'payeeId') : draw.payeeId;
    this.#payee(deal, payeeId);
    this.#append(actor, {
      tenantId: draw.tenantId,
      type: 'DRAW_AMENDED',
      drawId,
      dealId: draw.dealId,
      data: { before: { lines: draw.lines, payeeId: draw.payeeId }, after: { lines, payeeId } },
    });
    draw.lines = lines;
    draw.payeeId = payeeId;
    return snapshot(draw);
  }

  attachEvidence(session, drawId, input) {
    const actor = this.#actor(session, input);
    const draw = this.#draw(actor, drawId);
    this.#requireRequester(actor, draw, 'attach evidence');
    if (!ATTACH_OPEN.has(draw.state)) {
      throw new DrawError('EVIDENCE_LOCKED', `The manifest is frozen in ${draw.state}; supersede an existing item instead`);
    }
    const record = ingestEvidence({ input, actor, now: this.#now(), id: newId('ev') });
    this.#append(actor, { tenantId: draw.tenantId, type: 'EVIDENCE_INGESTED', drawId, dealId: draw.dealId, data: record });
    draw.evidence.push(record);
    return snapshot(record);
  }

  /** Evidence is never deleted or edited — only superseded by a new, separately hashed item. */
  supersedeEvidence(session, drawId, evidenceId, input) {
    const actor = this.#actor(session, input);
    const draw = this.#draw(actor, drawId);
    this.#requireRequester(actor, draw, 'supersede evidence');
    if (!SUPERSEDE_OPEN.has(draw.state)) {
      throw new DrawError('EVIDENCE_LOCKED', `Evidence is locked once settlement is instructed (${draw.state})`);
    }
    const old = draw.evidence.find((e) => e.id === evidenceId);
    if (!old) throw new DrawError('NOT_FOUND', `Evidence ${evidenceId} not found`);
    if (old.supersededBy) throw new DrawError('VALIDATION', `Evidence ${evidenceId} is already superseded`);
    const record = ingestEvidence({
      input: { type: old.type, ...input },
      actor,
      now: this.#now(),
      id: newId('ev'),
    });
    if (record.type !== old.type) throw new DrawError('VALIDATION', 'A superseding item must keep the same evidence type');
    record.supersedes = old.id;
    this.#append(actor, {
      tenantId: draw.tenantId,
      type: 'EVIDENCE_SUPERSEDED',
      drawId,
      dealId: draw.dealId,
      data: { supersedes: old.id, record },
    });
    old.supersededBy = record.id;
    draw.evidence.push(record);

    if (draw.state === S.UNDER_REVIEW || draw.state === S.APPROVED) {
      this.#refreezeManifest(actor, draw);
      if (draw.state === S.APPROVED) {
        this.#breakBinding(actor, draw, `Evidence ${old.type} was superseded after approval`);
      }
    }
    return snapshot(record);
  }

  /** DRAFT/HELD/REQUIRES_INFORMATION → SUBMITTED → UNDER_REVIEW | HELD | REQUIRES_INFORMATION. */
  submit(session, drawId) {
    const actor = this.#actor(session);
    const draw = this.#draw(actor, drawId);
    this.#requireRequester(actor, draw, 'submit a draw');
    assertTransition(draw.state, S.SUBMITTED);
    const deal = this.#deal(actor, draw.dealId);

    const policyVersion = draw.policyVersion ?? deal.policyVersion; // locked at first submit
    getPolicyPack(this.#packs, policyVersion);
    const { manifest, manifestHash } = freezeManifest(draw.evidence);
    this.#transition(actor, draw, S.SUBMITTED, { policyVersion, manifestHash, evidenceIds: manifest.map((m) => m.id) });
    draw.policyVersion = policyVersion;
    draw.manifest = manifest;
    draw.manifestHash = manifestHash;
    draw.approvals = [];
    draw.bindingNotice = null;

    const { controls, evaluation } = this.#assess(draw, deal);
    const next =
      evaluation.outcome === 'FAIL' ? S.REQUIRES_INFORMATION : evaluation.outcome === 'HOLD' ? S.HELD : S.UNDER_REVIEW;
    this.#transition('system:policy', draw, next, {
      outcome: evaluation.outcome,
      ruleIds: evaluation.reasons.map((r) => r.ruleId),
      freshnessScore: evaluation.freshness.score,
    });
    draw.controls = controls;
    draw.evaluation = evaluation;
    return snapshot(draw);
  }

  /**
   * Approve takes no controls from the caller. Any extra argument is never
   * read: eligible amount, covenants, cooling and sanctions are recomputed here.
   */
  approve(session, drawId) {
    const actor = this.#actor(session);
    const draw = this.#draw(actor, drawId);
    if (draw.state !== S.UNDER_REVIEW) {
      throw new DrawError('ILLEGAL_TRANSITION', `A draw in ${draw.state} cannot be approved`);
    }
    const deal = this.#deal(actor, draw.dealId);
    const { pack, controls, evaluation } = this.#assess(draw, deal);
    const binding = this.#binding(draw, controls);
    const validApprovals = draw.approvals.filter((a) => a.bindingHash === binding);
    assertCanApprove({ actor, draw, pack, validApprovals });

    if (evaluation.outcome === 'HOLD' || evaluation.outcome === 'FAIL') {
      this.#transition(actor, draw, S.HELD, {
        reason: 'Controls failed at approval time',
        outcome: evaluation.outcome,
        ruleIds: evaluation.reasons.map((r) => r.ruleId),
      });
      draw.controls = controls;
      draw.evaluation = evaluation;
      draw.approvals = [];
      return snapshot(draw);
    }

    const approval = {
      actorId: actor.id,
      roles: actor.roles.filter((r) => pack.approverRoles.includes(r)),
      bindingHash: binding,
      at: this.#now().toISOString(),
    };
    const dropped = draw.approvals.filter((a) => a.bindingHash !== binding).map((a) => a.actorId);
    this.#append(actor, {
      tenantId: draw.tenantId,
      type: 'APPROVAL_RECORDED',
      drawId,
      dealId: draw.dealId,
      data: { ...approval, count: validApprovals.length + 1, required: controls.requiredApprovals, droppedStaleApprovals: dropped },
    });
    draw.approvals = [...validApprovals, approval];
    draw.controls = controls;
    draw.evaluation = evaluation;

    if (draw.approvals.length >= controls.requiredApprovals) {
      this.#transition(actor, draw, S.APPROVED, {
        bindingHash: binding,
        approvers: draw.approvals.map((a) => a.actorId),
        eligibleMinor: controls.eligibleMinor,
      });
      draw.bindingHash = binding;
      draw.bindingNotice = null;
    }
    return snapshot(draw);
  }

  /** First-class binding break: APPROVED → UNDER_REVIEW, approvals voided. */
  breakBinding(session, drawId, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.RISK_OWNER, ROLES.UNDERWRITER, ROLES.LENDER_ADMIN, ROLES.TREASURY_OWNER], 'break an approval binding');
    const draw = this.#draw(actor, drawId);
    if (draw.state !== S.APPROVED) throw new DrawError('ILLEGAL_TRANSITION', `No binding to break in ${draw.state}`);
    this.#breakBinding(actor, draw, requireString(input?.reason, 'reason'));
    return snapshot(draw);
  }

  /** Writes an instruction for the partner. DIBS does not move money. */
  instructSettlement(session, drawId) {
    const actor = this.#actor(session);
    const draw = this.#draw(actor, drawId);
    if (draw.state !== S.APPROVED) throw new DrawError('ILLEGAL_TRANSITION', `A draw in ${draw.state} cannot be instructed`);
    const deal = this.#deal(actor, draw.dealId);
    const pack = this.#pack(draw, deal);
    assertCanInstruct({ actor, draw, pack });

    const { controls } = this.#assess(draw, deal);
    const binding = this.#binding(draw, controls);
    if (binding !== draw.bindingHash) {
      this.#breakBinding(actor, draw, 'The draw changed after approval (detected at instruction)');
      throw new DrawError('BINDING_BROKEN', 'Approval binding no longer matches; draw returned to UNDER_REVIEW', {
        state: draw.state,
      });
    }

    const instruction = {
      id: newId('instr'),
      drawId,
      amountMinor: controls.eligibleMinor,
      currency: 'USD',
      payeeId: draw.payeeId,
      payeeAccountFingerprint: controls.payeeAccountFingerprint,
      bindingHash: binding,
      instructedBy: actor.id,
      instructedAt: this.#now().toISOString(),
    };
    this.#transition(actor, draw, S.SETTLEMENT_INSTRUCTED, { instruction });
    draw.instruction = instruction;
    return snapshot(draw);
  }

  #parseConfirmation(input) {
    const settledAt = parseDate(input?.settledAt, 'settledAt');
    return {
      instructionId: requireString(input.instructionId, 'instructionId'),
      partnerRef: requireString(input.partnerRef, 'partnerRef'),
      amountMinor: parseMinor(input.amountMinor, 'amountMinor'),
      payeeAccountFingerprint: requireString(input.payeeAccountFingerprint, 'payeeAccountFingerprint'),
      settledAt: settledAt.toISOString(),
    };
  }

  /** Partner API confirmation. Only a SettlementPartner service account may post it. */
  recordPartnerConfirmation(session, drawId, input) {
    const actor = this.#actor(session, input);
    requireRole(actor, [ROLES.SETTLEMENT_PARTNER], 'record a partner confirmation');
    if (actor.kind !== 'service') throw new DrawError('ROLE_REQUIRED', 'Partner confirmations come from the partner integration');
    const draw = this.#draw(actor, drawId);
    if (!CONFIRM_OPEN.has(draw.state)) throw new DrawError('ILLEGAL_TRANSITION', `No confirmation expected in ${draw.state}`);
    const confirmation = { ...this.#parseConfirmation(input), source: 'PARTNER_API', recordedBy: [actor.id] };
    this.#confirmAndReconcile(actor, draw, confirmation);
    return snapshot(draw);
  }

  /** Manual CSV path: two different people must key the same row. */
  enterCsvConfirmation(session, drawId, input) {
    const actor = this.#actor(session, input);
    requireHuman(actor, 'ROLE_REQUIRED', 'key a CSV confirmation');
    requireRole(actor, [ROLES.TREASURY_OWNER, ROLES.LENDER_ADMIN], 'key a CSV confirmation');
    const draw = this.#draw(actor, drawId);
    if (!CONFIRM_OPEN.has(draw.state)) throw new DrawError('ILLEGAL_TRANSITION', `No confirmation expected in ${draw.state}`);
    const row = this.#parseConfirmation(input);
    const rowHash = hashOf(row);

    if (!draw.csvPending) {
      this.#append(actor, { tenantId: draw.tenantId, type: 'CSV_ENTRY_FIRST', drawId, dealId: draw.dealId, data: { rowHash } });
      draw.csvPending = { rowHash, row, enteredBy: actor.id };
      return snapshot(draw);
    }
    if (draw.csvPending.enteredBy === actor.id) {
      throw new DrawError('SOD_CSV_SAME_PERSON', 'The second CSV entry must be keyed by a different person');
    }
    if (draw.csvPending.rowHash !== rowHash) {
      this.#append(actor, {
        tenantId: draw.tenantId,
        type: 'CSV_ENTRY_MISMATCH',
        drawId,
        dealId: draw.dealId,
        data: { first: draw.csvPending.rowHash, second: rowHash, firstBy: draw.csvPending.enteredBy },
      });
      draw.csvPending = null;
      throw new DrawError('CSV_ENTRY_MISMATCH', 'The two CSV entries differ; both were discarded. Key the row again.');
    }
    const firstBy = draw.csvPending.enteredBy;
    this.#append(actor, { tenantId: draw.tenantId, type: 'CSV_ENTRY_SECOND', drawId, dealId: draw.dealId, data: { rowHash, firstBy } });
    draw.csvPending = null;
    this.#confirmAndReconcile(actor, draw, { ...row, source: 'CSV_DUAL_ENTRY', recordedBy: [firstBy, actor.id] });
    return snapshot(draw);
  }

  /** Instruction ≠ confirmation ≠ reconciliation. Disagreement holds; nobody is silently preferred. */
  #confirmAndReconcile(actor, draw, confirmation) {
    this.#transition(actor, draw, S.SETTLEMENT_CONFIRMED, { confirmation });
    draw.confirmation = confirmation;

    const instr = draw.instruction;
    const breaks = [];
    const blocked = instr.amountMinor;
    if (confirmation.instructionId !== instr.id) {
      breaks.push({
        ruleId: 'RECON.INSTRUCTION_MISMATCH',
        outcome: 'HOLD',
        scope: 'settlement',
        blockedMinor: blocked,
        title: 'Confirmation references a different instruction',
        why: `DIBS issued ${instr.id}; the partner confirmed ${confirmation.instructionId}.`,
        clearsWhen: 'The partner sends a confirmation for this instruction.',
      });
    }
    if (confirmation.amountMinor !== instr.amountMinor) {
      breaks.push({
        ruleId: 'RECON.AMOUNT_MISMATCH',
        outcome: 'HOLD',
        scope: 'settlement',
        blockedMinor: blocked,
        title: 'Partner confirmed a different amount',
        why: `DIBS instructed ${formatUsd(instr.amountMinor)}; the partner confirmed ${formatUsd(confirmation.amountMinor)}. Neither figure is assumed correct.`,
        clearsWhen: 'Treasury and the partner agree the figure and the partner sends a corrected confirmation.',
      });
    }
    if (confirmation.payeeAccountFingerprint !== instr.payeeAccountFingerprint) {
      breaks.push({
        ruleId: 'RECON.PAYEE_ACCOUNT_MISMATCH',
        outcome: 'HOLD',
        scope: 'settlement',
        blockedMinor: blocked,
        title: 'Funds went to a different account',
        why: 'The confirmed payee account does not match the account in the approved instruction.',
        clearsWhen: 'Treasury investigates with the partner and a corrected confirmation matches the instruction.',
      });
    }
    const reconciliation = {
      status: breaks.length ? 'EXCEPTION' : 'MATCHED',
      breaks,
      reconciledAt: this.#now().toISOString(),
    };
    this.#transition(RECONCILER, draw, breaks.length ? S.RECONCILIATION_EXCEPTION : S.RECONCILED, {
      status: reconciliation.status,
      ruleIds: breaks.map((b) => b.ruleId),
    });
    draw.reconciliation = reconciliation;
  }

  close(session, drawId) {
    const actor = this.#actor(session);
    requireRole(actor, [ROLES.TREASURY_OWNER, ROLES.LENDER_ADMIN], 'close a draw');
    const draw = this.#draw(actor, drawId);
    assertTransition(draw.state, S.CLOSED);
    const deal = this.#deal(actor, draw.dealId);
    const drawnByLine = draw.lines.map((l) => ({ code: l.budgetCode, amountMinor: l.amountMinor }));
    const gross = draw.lines.reduce((a, l) => a + l.amountMinor, 0n);
    this.#transition(actor, draw, S.CLOSED, { drawnByLine, grossMinor: gross });
    for (const l of drawnByLine) {
      deal.budgetLines.find((b) => b.code === l.code).drawnMinor += l.amountMinor;
    }
    deal.drawnGrossMinor += gross;
    return snapshot(draw);
  }

  // ───────────────────────────── reads

  getDraw(session, drawId) {
    const actor = this.#actor(session);
    return snapshot(this.#draw(actor, drawId));
  }

  listDraws(session, filter = {}) {
    const actor = this.#actor(session, filter);
    return [...this.#space(actor.tenantId).draws.values()]
      .filter((d) => !filter.state || d.state === filter.state)
      .map(snapshot);
  }

  /** The desk card: every blocker readable in under a minute. */
  desk(session, drawId) {
    const actor = this.#actor(session);
    const draw = this.#draw(actor, drawId);
    const deal = this.#deal(actor, draw.dealId);
    const reasons = [];
    if (draw.evaluation && [S.HELD, S.REQUIRES_INFORMATION, S.SUBMITTED].includes(draw.state)) {
      reasons.push(...draw.evaluation.reasons);
    } else if (draw.evaluation && draw.state === S.UNDER_REVIEW) {
      reasons.push(...draw.evaluation.reasons.filter((r) => r.outcome === 'REVIEW_REQUIRED'));
    }
    if (draw.bindingNotice && draw.state === S.UNDER_REVIEW) reasons.push(draw.bindingNotice);
    if (draw.state === S.RECONCILIATION_EXCEPTION) reasons.push(...draw.reconciliation.breaks);

    const render = (r) => ({
      title: r.title,
      why: r.why,
      clearsWhen: r.clearsWhen,
      ruleId: r.ruleId,
      scope: r.scope,
      outcome: r.outcome,
      blockedMinor: r.blockedMinor,
      blocked: formatUsd(r.blockedMinor),
    });
    const holds = reasons.filter((r) => r.outcome === 'HOLD' || r.outcome === 'FAIL').map(render);
    const notes = reasons.filter((r) => r.outcome === 'REVIEW_REQUIRED').map(render);
    const gross = draw.lines.reduce((a, l) => a + l.amountMinor, 0n);
    const blockedMinor = holds.reduce((m, h) => (h.blockedMinor > m ? h.blockedMinor : m), 0n);
    return {
      drawId: draw.id,
      deal: deal.name,
      state: draw.state,
      requested: formatUsd(gross),
      eligible: draw.controls ? formatUsd(draw.controls.eligibleMinor) : null,
      retainage: draw.controls ? formatUsd(draw.controls.retainageMinor) : null,
      approvals: draw.controls ? `${draw.approvals.length} of ${draw.controls.requiredApprovals}` : null,
      headline: holds.length
        ? `${draw.state}: ${holds.length} hold${holds.length > 1 ? 's' : ''}, ${formatUsd(blockedMinor)} blocked`
        : `${draw.state}: nothing blocking`,
      holds,
      notes,
    };
  }

  auditTrail(session, { drawId } = {}) {
    const actor = this.#actor(session);
    return this.#audit.events(actor.tenantId, { drawId });
  }

  verifyAudit(session) {
    const actor = this.#actor(session);
    return this.#audit.verify(actor.tenantId);
  }
}
