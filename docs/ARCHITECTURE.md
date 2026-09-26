# Architecture

Track A is one in-memory engine, `ControlledDrawEngine` (`src/engine.js`), with pure helpers around it. It is a reference for the rules, not a production service: persistence, identity, and partner integrations are left as seams.

## Boundaries

```text
          session { actor }                      partner (service account)
               │                                         │
               ▼                                         ▼
  ┌──────────────────────── ControlledDrawEngine ────────────────────────┐
  │  #actor()  → validates session, rejects any client tenantId          │
  │  #space(tenantId) → per-tenant deals + draws (no cross-tenant reads) │
  │                                                                      │
  │  computeControls()  evaluatePolicy()  assertCanApprove/Instruct()    │
  │        (pure)            (pure)                (pure)                │
  │                                                                      │
  │  #transition()  = assertTransition → audit.append → mutate           │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 ▼
                      AuditLog (per-tenant hash chain)
```

- **Session.** Every public method takes `{ actor }` first. `actor.tenantId` is the only tenant source. Any `tenantId` / `tenant_id` key in client input, at any depth, throws `CLIENT_TENANT_ID_REJECTED`.
- **Lookups.** Deals and draws are read only from the caller's tenant space. A draw that exists in another tenant returns the same `NOT_FOUND` as one that does not exist.
- **Snapshots.** The engine returns `structuredClone` copies. Callers cannot mutate internal state.

## Lifecycle

| Step | Method | Who | What is fixed |
|---|---|---|---|
| Create | `createDraw` | Sponsor | lines, payee |
| Evidence | `attachEvidence` / `supersedeEvidence` | requester | SHA-256 computed on ingest |
| Submit | `submit` | requester | policy version locked (first submit); manifest frozen; outcome routes to `UNDER_REVIEW`, `HELD`, or `REQUIRES_INFORMATION` |
| Approve | `approve` | approver role, human, not requester | controls recomputed; binding hash; N distinct approvals on the same binding |
| Break | `breakBinding` (and automatic) | risk / lender / treasury, or system | `APPROVED → UNDER_REVIEW`, approvals voided |
| Instruct | `instructSettlement` | `TreasuryOwner`, not requester, not an approver | binding re-verified; instruction amount = computed eligible |
| Confirm | `recordPartnerConfirmation` / `enterCsvConfirmation` ×2 | partner service / two humans | confirmation stored separately from instruction |
| Reconcile | automatic on confirm | `system:reconciler` | instruction id, amount, payee account compared |
| Close | `close` | treasury / lender admin | only from `RECONCILED`; deal budget drawn updated |

### Outcome routing at submit

| Policy outcome | Next state | Typical rules |
|---|---|---|
| `PASS`, `REVIEW_REQUIRED` | `UNDER_REVIEW` | dual control noted |
| `HOLD` | `HELD` | missing / stale required evidence, payee cooling, sanctions age |
| `FAIL` | `REQUIRES_INFORMATION` | unknown or over-budget line, commitment cap, maturity, unknown payee |

`HOLD` clears with time or documents. `FAIL` requires the sponsor to change the request (`amendDraw`). Both return through `SUBMITTED`.

## Binding

`bindingHash = sha256(canonical({ drawId, tenantId, dealId, payeeId, payeeAccountFingerprint, lines, grossMinor, retainageMinor, eligibleMinor, manifestHash, policyVersion }))`.

An approval counts only while its binding equals the current one. The binding breaks, and the draw returns to `UNDER_REVIEW`, when any of these happens:

- evidence is superseded after approval (the manifest re-freezes),
- the payee's bank account changes (`changePayeeAccount`),
- someone calls `breakBinding` with a reason,
- the recomputed binding differs at instruction time.

## Controls (server-side only)

`computeControls` derives, per request:

- per-line remaining budget, and a fundable amount = min(requested, remaining),
- retainage = ceil(fundable × `retainageBps` / 10 000), and eligible = fundable − retainage,
- commitment headroom and maturity,
- payee account age (cooling) and sanctions-screen age,
- required approvals (1 or 2 by deal threshold).

`approve` takes no controls argument. Anything a caller passes is never read.

## Audit

`AuditLog.append` builds `{ seq, tenantId, at, actorId, type, drawId, dealId, from, to, data, prevHash }`, hashes it canonically, deep-freezes it, and appends it. `#transition` appends before it assigns `draw.state`. If the append throws, state is unchanged. `verify()` recomputes every link. `AuditLog.verifyEvents()` checks any exported copy.

## Seams for production

| Seam | Reference behavior | Production replacement |
|---|---|---|
| Identity | `x-actor` header → fixture actor | OIDC / SAML, roles from the IdP |
| Storage | in-memory `Map`s | Postgres with row-level security on `tenant_id`, audit table append-only |
| Evidence bytes | hashed then discarded | object storage with WORM retention, keyed by SHA-256 |
| Sanctions | recorded timestamp | screening provider callback |
| Partner | service account posts confirmation | signed webhook + CSV import, both into the same two paths |
