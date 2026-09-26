# DIBS Capital Autopilot — Controlled Draws

**Capital cannot move until the right policy, evidence, approvals, and covenant checks are satisfied.**

Track A reference engine for a multi-tenant, policy-enforced controlled-draw control plane. Built for private construction, bridge, and renovation lenders — not for vaults, tokenization, or quantum research.

This tree replaces the original repository’s README-only stub. The advertised files `DIBS-Capital-Autopilot.md` and `docs/QUANTUM-AND-PQC-SCAFFOLD.md` never existed in that repo. They are not re-introduced here.

---

## Core invariant

```text
No capital-state change without:
  policy
  + evidence
  + authorization
  + settlement confirmation
  + reconciliation
  + immutable audit event
```

DIBS writes settlement **instructions** and records partner **confirmations**.
DIBS does not hold funds, issue credit, or press a payment-provider release.
If DIBS and a partner disagree, the draw is **held**. Neither side is silently preferred.

---

## State machine

```text
DRAFT
  → SUBMITTED                         # policy + evidence manifest freeze
  → UNDER_REVIEW | HELD | REQUIRES_INFORMATION
  → APPROVED                          # binding hash
  → SETTLEMENT_INSTRUCTED
  → SETTLEMENT_CONFIRMED
  → RECONCILED | RECONCILIATION_EXCEPTION
  → CLOSED
```

A reconciliation break cannot close. An approval-binding break returns the draw to `UNDER_REVIEW`.

---

## What this engine actually enforces

| Control | Behavior |
|---|---|
| Single machine | `DrawRequest` only. No second `CapitalRequest` machine. |
| Tenant isolation | `tenant_id` from the session. Client `tenantId` is a hard error. |
| Money | Integer minor units (`bigint`). No floats. |
| Evidence | SHA-256 on ingest. Manifest freeze at submit. Supersede only. Freshness scored on **required** types, not optional extras. |
| Policy | Versioned pack locked at `SUBMITTED`. Result is `PASS \| HOLD \| FAIL \| REVIEW_REQUIRED` plus desk-readable reasons. |
| SoD | Requester ≠ approver ≠ instructor. Service accounts cannot approve. Dual control above the deal threshold. |
| Controls | Budget, retainage, covenants, payee cooling, sanctions age computed server-side. Client `ApprovalControls` are ignored because they are never accepted. |
| Settlement | Instruction ≠ confirmation ≠ recon. CSV dual-entry requires two people. |
| Audit | Event appended before state mutate. Hash chain + `verify()`. |
| Desk | Every hold has `title`, `why`, `clearsWhen`, `ruleId`, `scope`, and dollars blocked. Readable in under a minute. |

Construction v0 policy pack (`policy-2026.09.26-construction`):

- required evidence: `INVOICE`, `INSPECTION_REPORT`, `LIEN_WAIVER`
- 1 approval below the deal dual-control threshold; 2 at or above
- approvers: `RiskOwner`, `Underwriter`, `LenderAdmin`
- instructor: `TreasuryOwner`
- sanctions max age: 30 days; payee cooling: 24 hours

---

## Run

```bash
npm install
npm test
npm run demo
npm start          # http://127.0.0.1:8787  header x-actor: sponsor|risk|treasury
```

Requires Node 20+. No runtime dependencies.

---

## Proven paths (`npm test`)

- Happy path `DRAFT → CLOSED` with a live hash-chained audit
- Missing inspection at submit → `HELD`, desk copy names the document and how to clear it
- Self-approval blocked
- Service-account approval blocked
- Cross-tenant access denied
- Client-supplied `tenantId` rejected
- Dual control: $300,000 needs two distinct approvers
- Approver cannot instruct settlement
- Binding break from `APPROVED` → `UNDER_REVIEW`
- Confirmation amount mismatch → `RECONCILIATION_EXCEPTION`; `CLOSED` illegal
- Eligible amount computed from budget + retainage, not from the approver

---

## Layout

```text
src/
  engine.js      ControlledDrawEngine — the only state-changing surface
  states.js      DrawRequest states and legal transitions
  policy.js      versioned policy packs, evaluatePolicy(), freshness score
  controls.js    server-side eligible / retainage / covenant / payee controls
  sod.js         separation-of-duties checks
  evidence.js    SHA-256 ingest, manifest freeze
  audit.js       per-tenant hash-chained append-only log + verify()
  money.js       bigint minor units
  server.js      dev HTTP surface (x-actor header stands in for auth)
  seed.js        fixture tenants, actors, and a construction deal
test/            node:test suites
scripts/demo.js  prints the desk for a held draw and a dual-control close
docs/            ARCHITECTURE.md, THREAT-MODEL.md
```

---

## What not to build next

Do not put these on the Autopilot draw desk:

- ERC-4626 vaults, Sentinel / Catalyst tranches
- QAOA / QUBO / ML-KEM / ML-DSA
- Tokenization or policy-loan automation
- Super Agents that can approve or instruct

Those stories belong in other repositories. Track A is a file a credit officer can defend.

---

## Related work

Original spec stub: [dibs-financial/DIBS-Capital-Autopilot-Controlled-Draws](https://github.com/dibs-financial/DIBS-Capital-Autopilot-Controlled-Draws)

Broader monorepo (TypeScript + contracts): [dibs-financial/dibs-trust-capital-network](https://github.com/dibs-financial/dibs-trust-capital-network)

Priority patches for that monorepo:

1. Stop linking files that 404. README must match the tree.
2. Retire `CapitalRequest` in evidence-gating. One machine.
3. Compute `ApprovalContext` server-side; reject client controls.
4. Unit-test `transitionDraw` and `approvalFailures`.
5. Let `SUBMITTED` go `HELD` / `REQUIRES_INFORMATION`.
6. First-class `breakBinding()`.
7. Dual-control threshold + instructor role disjoint from approvers.

---

## Deployment rule

Do not use production capital, custody, tokenization, insurance, securities, lending, QOF/QOZ, or DeFi workflows until applicable legal, tax, compliance, security, servicing, custody, and independent-review gates are satisfied.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), and [`SECURITY.md`](SECURITY.md).
